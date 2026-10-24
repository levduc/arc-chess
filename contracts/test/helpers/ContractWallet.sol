// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Test-only smart-contract wallet. Its owner relays calls through it, so at the target the wallet, not the
/// owner, is `msg.sender`. Audit M1's redirect needs exactly this on Arc: Arc refuses a blocklisted EOA's own
/// transactions, but a blocklisted contract wallet can still act when a clean owner or a relayer pays the gas.
/// Used by `packages/cli/test/arc/claim.test.ts`, which loads it from `contracts/out`.
contract ContractWallet {
    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }

    /// @dev Bubbles the target's revert data unchanged, so a test sees the token's own reason.
    function exec(address target, bytes calldata data) external returns (bytes memory ret) {
        require(msg.sender == owner, "not owner");
        bool ok;
        (ok, ret) = target.call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
    }
}
