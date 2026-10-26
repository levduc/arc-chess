// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

/// @notice Code that accepts every ERC-1271 query: a griefer's contract signer, or the delegate of a session key under
/// an EIP-7702 delegation (etched onto the key's address). Final review A I-1: the hub must not accept its bytes.
contract AcceptAllERC1271 is IERC1271 {
    function isValidSignature(bytes32, bytes memory) external pure returns (bytes4) {
        return IERC1271.isValidSignature.selector;
    }
}
