// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test-only 6-decimal token that returns false (never reverts) on a transfer touching a blocked
/// address. Used by the invariant suite to force ChannelHub's `owed` deferred-payout fallback (see `_pay`
/// in ChannelHub.sol) down its false-return branch specifically, as distinct from the MockUSDC-based
/// suite, which covers the revert branch (MockUSDC reverts on a blocked transfer).
contract BlockingToken is ERC20 {
    mapping(address => bool) public blocked;

    constructor() ERC20("Blocking USDC", "bUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address who, bool isBlocked) external {
        blocked[who] = isBlocked;
    }

    /// @dev `_pay` in ChannelHub does a raw `.call` to `transfer` and treats a `false` return (not a
    /// revert) as "the token refused" -> deferred to `owed`. Overriding here (rather than `_update`,
    /// which cannot return a value) is what makes that specific branch reachable.
    function transfer(address to, uint256 value) public override returns (bool) {
        if (blocked[msg.sender] || blocked[to]) return false;
        return super.transfer(to, value);
    }

    /// @dev `deposit()` uses `safeTransferFrom`; a `false` return here makes SafeERC20 revert, which is
    /// still the correct "sender is blocked" behavior for funding (see HubHandler's liveness checks).
    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (blocked[from] || blocked[to]) return false;
        return super.transferFrom(from, to, value);
    }
}
