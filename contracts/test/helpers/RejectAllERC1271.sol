// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

/// @notice Code that rejects every ERC-1271 query; etched onto an EOA signer to simulate it gaining code.
contract RejectAllERC1271 is IERC1271 {
    function isValidSignature(bytes32, bytes memory) external pure returns (bytes4) {
        return bytes4(0xffffffff);
    }
}
