// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test-only 6-decimal token that reverts (never returns false) on any transfer touching a
/// blocked address. Used by the invariant suite to force ChannelHub's `owed` deferred-payout fallback
/// (see `_pay` in ChannelHub.sol) down its revert path, as distinct from a false-returning token.
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

    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[from] && !blocked[to], "BlockingToken: blocked");
        super._update(from, to, value);
    }
}
