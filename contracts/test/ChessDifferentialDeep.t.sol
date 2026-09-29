// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ChessDifferentialBase} from "./helpers/ChessDifferentialBase.sol";

/// @notice Runs the same checks as ChessDifferentialTest against the deep vector set (currently ~11,000
/// positions across ~74 chunks; see task-5-report.md). Generate with `pnpm vectors:deep`. Only runs when
/// ARENA_DEEP_VECTORS=1 (set by `pnpm test:contracts:deep`); skips cleanly otherwise so the default
/// `forge test` loop never depends on the (large, gitignored) deep vectors.
///
/// One test function per chunk, not a single function looping over every chunk, on purpose: each `forge test`
/// function gets its own gas budget and its own top-level memory space. A single function processing all
/// chunks measurably ran out of gas partway through (this profile's gas_limit is ~1.07B; the full deep set
/// needs tens of billions of gas overall, but any one ~150-position chunk fits comfortably within a single
/// test's budget). The chunk count is dynamic (it depends on how many positions `pnpm vectors:deep` sampled),
/// so there are more test_chunkN functions here than chunks currently exist; `_runOrSkip` skips (not fails)
/// any chunk number beyond the real count, and `test_deepVectorsPresent` fails loudly if chunk-0 is missing
/// entirely (i.e. `pnpm vectors:deep` was never run).
contract ChessDifferentialDeepTest is ChessDifferentialBase {
    // Must match tools/vectors/src/generate.ts's DEEP_CHUNK_CEILING and this file's test_chunk0..test_chunk199.
    uint256 internal constant DEEP_CHUNK_CEILING = 200;

    function test_deepVectorsPresent() public {
        if (vm.envOr("ARENA_DEEP_VECTORS", uint256(0)) != 1) {
            vm.skip(true);
            return;
        }
        require(vm.exists(_chunkPath(0)), "no deep vectors found: run `pnpm vectors:deep`");
        // generate.ts refuses to write more than DEEP_CHUNK_CEILING chunks, but fail loudly (not silently
        // under-test) if that guard was ever bypassed or the ceiling constants drift out of sync.
        require(
            !vm.exists(_chunkPath(DEEP_CHUNK_CEILING)),
            "chunk-200.hex exists but only test_chunk0..test_chunk199 are defined: raise DEEP_CHUNK_CEILING in both generate.ts and here, and add more test_chunkN functions"
        );
    }

    function _runOrSkip(uint256 chunk) internal {
        if (vm.envOr("ARENA_DEEP_VECTORS", uint256(0)) != 1) {
            vm.skip(true);
            return;
        }
        string memory path = _chunkPath(chunk);
        if (!vm.exists(path)) {
            vm.skip(true);
            return;
        }
        _runPath(path);
    }

    function _chunkPath(uint256 chunk) internal view returns (string memory) {
        return string.concat(vm.projectRoot(), "/test/vectors-deep/chunk-", vm.toString(chunk), ".hex");
    }

    function test_chunk0() public { _runOrSkip(0); }
    function test_chunk1() public { _runOrSkip(1); }
    function test_chunk2() public { _runOrSkip(2); }
    function test_chunk3() public { _runOrSkip(3); }
    function test_chunk4() public { _runOrSkip(4); }
    function test_chunk5() public { _runOrSkip(5); }
    function test_chunk6() public { _runOrSkip(6); }
    function test_chunk7() public { _runOrSkip(7); }
    function test_chunk8() public { _runOrSkip(8); }
    function test_chunk9() public { _runOrSkip(9); }
    function test_chunk10() public { _runOrSkip(10); }
    function test_chunk11() public { _runOrSkip(11); }
    function test_chunk12() public { _runOrSkip(12); }
    function test_chunk13() public { _runOrSkip(13); }
    function test_chunk14() public { _runOrSkip(14); }
    function test_chunk15() public { _runOrSkip(15); }
    function test_chunk16() public { _runOrSkip(16); }
    function test_chunk17() public { _runOrSkip(17); }
    function test_chunk18() public { _runOrSkip(18); }
    function test_chunk19() public { _runOrSkip(19); }
    function test_chunk20() public { _runOrSkip(20); }
    function test_chunk21() public { _runOrSkip(21); }
    function test_chunk22() public { _runOrSkip(22); }
    function test_chunk23() public { _runOrSkip(23); }
    function test_chunk24() public { _runOrSkip(24); }
    function test_chunk25() public { _runOrSkip(25); }
    function test_chunk26() public { _runOrSkip(26); }
    function test_chunk27() public { _runOrSkip(27); }
    function test_chunk28() public { _runOrSkip(28); }
    function test_chunk29() public { _runOrSkip(29); }
    function test_chunk30() public { _runOrSkip(30); }
    function test_chunk31() public { _runOrSkip(31); }
    function test_chunk32() public { _runOrSkip(32); }
    function test_chunk33() public { _runOrSkip(33); }
    function test_chunk34() public { _runOrSkip(34); }
    function test_chunk35() public { _runOrSkip(35); }
    function test_chunk36() public { _runOrSkip(36); }
    function test_chunk37() public { _runOrSkip(37); }
    function test_chunk38() public { _runOrSkip(38); }
    function test_chunk39() public { _runOrSkip(39); }
    function test_chunk40() public { _runOrSkip(40); }
    function test_chunk41() public { _runOrSkip(41); }
    function test_chunk42() public { _runOrSkip(42); }
    function test_chunk43() public { _runOrSkip(43); }
    function test_chunk44() public { _runOrSkip(44); }
    function test_chunk45() public { _runOrSkip(45); }
    function test_chunk46() public { _runOrSkip(46); }
    function test_chunk47() public { _runOrSkip(47); }
    function test_chunk48() public { _runOrSkip(48); }
    function test_chunk49() public { _runOrSkip(49); }
    function test_chunk50() public { _runOrSkip(50); }
    function test_chunk51() public { _runOrSkip(51); }
    function test_chunk52() public { _runOrSkip(52); }
    function test_chunk53() public { _runOrSkip(53); }
    function test_chunk54() public { _runOrSkip(54); }
    function test_chunk55() public { _runOrSkip(55); }
    function test_chunk56() public { _runOrSkip(56); }
    function test_chunk57() public { _runOrSkip(57); }
    function test_chunk58() public { _runOrSkip(58); }
    function test_chunk59() public { _runOrSkip(59); }
    function test_chunk60() public { _runOrSkip(60); }
    function test_chunk61() public { _runOrSkip(61); }
    function test_chunk62() public { _runOrSkip(62); }
    function test_chunk63() public { _runOrSkip(63); }
    function test_chunk64() public { _runOrSkip(64); }
    function test_chunk65() public { _runOrSkip(65); }
    function test_chunk66() public { _runOrSkip(66); }
    function test_chunk67() public { _runOrSkip(67); }
    function test_chunk68() public { _runOrSkip(68); }
    function test_chunk69() public { _runOrSkip(69); }
    function test_chunk70() public { _runOrSkip(70); }
    function test_chunk71() public { _runOrSkip(71); }
    function test_chunk72() public { _runOrSkip(72); }
    function test_chunk73() public { _runOrSkip(73); }
    function test_chunk74() public { _runOrSkip(74); }
    function test_chunk75() public { _runOrSkip(75); }
    function test_chunk76() public { _runOrSkip(76); }
    function test_chunk77() public { _runOrSkip(77); }
    function test_chunk78() public { _runOrSkip(78); }
    function test_chunk79() public { _runOrSkip(79); }
    function test_chunk80() public { _runOrSkip(80); }
    function test_chunk81() public { _runOrSkip(81); }
    function test_chunk82() public { _runOrSkip(82); }
    function test_chunk83() public { _runOrSkip(83); }
    function test_chunk84() public { _runOrSkip(84); }
    function test_chunk85() public { _runOrSkip(85); }
    function test_chunk86() public { _runOrSkip(86); }
    function test_chunk87() public { _runOrSkip(87); }
    function test_chunk88() public { _runOrSkip(88); }
    function test_chunk89() public { _runOrSkip(89); }
    function test_chunk90() public { _runOrSkip(90); }
    function test_chunk91() public { _runOrSkip(91); }
    function test_chunk92() public { _runOrSkip(92); }
    function test_chunk93() public { _runOrSkip(93); }
    function test_chunk94() public { _runOrSkip(94); }
    function test_chunk95() public { _runOrSkip(95); }
    function test_chunk96() public { _runOrSkip(96); }
    function test_chunk97() public { _runOrSkip(97); }
    function test_chunk98() public { _runOrSkip(98); }
    function test_chunk99() public { _runOrSkip(99); }
    function test_chunk100() public { _runOrSkip(100); }
    function test_chunk101() public { _runOrSkip(101); }
    function test_chunk102() public { _runOrSkip(102); }
    function test_chunk103() public { _runOrSkip(103); }
    function test_chunk104() public { _runOrSkip(104); }
    function test_chunk105() public { _runOrSkip(105); }
    function test_chunk106() public { _runOrSkip(106); }
    function test_chunk107() public { _runOrSkip(107); }
    function test_chunk108() public { _runOrSkip(108); }
    function test_chunk109() public { _runOrSkip(109); }
    function test_chunk110() public { _runOrSkip(110); }
    function test_chunk111() public { _runOrSkip(111); }
    function test_chunk112() public { _runOrSkip(112); }
    function test_chunk113() public { _runOrSkip(113); }
    function test_chunk114() public { _runOrSkip(114); }
    function test_chunk115() public { _runOrSkip(115); }
    function test_chunk116() public { _runOrSkip(116); }
    function test_chunk117() public { _runOrSkip(117); }
    function test_chunk118() public { _runOrSkip(118); }
    function test_chunk119() public { _runOrSkip(119); }
    function test_chunk120() public { _runOrSkip(120); }
    function test_chunk121() public { _runOrSkip(121); }
    function test_chunk122() public { _runOrSkip(122); }
    function test_chunk123() public { _runOrSkip(123); }
    function test_chunk124() public { _runOrSkip(124); }
    function test_chunk125() public { _runOrSkip(125); }
    function test_chunk126() public { _runOrSkip(126); }
    function test_chunk127() public { _runOrSkip(127); }
    function test_chunk128() public { _runOrSkip(128); }
    function test_chunk129() public { _runOrSkip(129); }
    function test_chunk130() public { _runOrSkip(130); }
    function test_chunk131() public { _runOrSkip(131); }
    function test_chunk132() public { _runOrSkip(132); }
    function test_chunk133() public { _runOrSkip(133); }
    function test_chunk134() public { _runOrSkip(134); }
    function test_chunk135() public { _runOrSkip(135); }
    function test_chunk136() public { _runOrSkip(136); }
    function test_chunk137() public { _runOrSkip(137); }
    function test_chunk138() public { _runOrSkip(138); }
    function test_chunk139() public { _runOrSkip(139); }
    function test_chunk140() public { _runOrSkip(140); }
    function test_chunk141() public { _runOrSkip(141); }
    function test_chunk142() public { _runOrSkip(142); }
    function test_chunk143() public { _runOrSkip(143); }
    function test_chunk144() public { _runOrSkip(144); }
    function test_chunk145() public { _runOrSkip(145); }
    function test_chunk146() public { _runOrSkip(146); }
    function test_chunk147() public { _runOrSkip(147); }
    function test_chunk148() public { _runOrSkip(148); }
    function test_chunk149() public { _runOrSkip(149); }
    function test_chunk150() public { _runOrSkip(150); }
    function test_chunk151() public { _runOrSkip(151); }
    function test_chunk152() public { _runOrSkip(152); }
    function test_chunk153() public { _runOrSkip(153); }
    function test_chunk154() public { _runOrSkip(154); }
    function test_chunk155() public { _runOrSkip(155); }
    function test_chunk156() public { _runOrSkip(156); }
    function test_chunk157() public { _runOrSkip(157); }
    function test_chunk158() public { _runOrSkip(158); }
    function test_chunk159() public { _runOrSkip(159); }
    function test_chunk160() public { _runOrSkip(160); }
    function test_chunk161() public { _runOrSkip(161); }
    function test_chunk162() public { _runOrSkip(162); }
    function test_chunk163() public { _runOrSkip(163); }
    function test_chunk164() public { _runOrSkip(164); }
    function test_chunk165() public { _runOrSkip(165); }
    function test_chunk166() public { _runOrSkip(166); }
    function test_chunk167() public { _runOrSkip(167); }
    function test_chunk168() public { _runOrSkip(168); }
    function test_chunk169() public { _runOrSkip(169); }
    function test_chunk170() public { _runOrSkip(170); }
    function test_chunk171() public { _runOrSkip(171); }
    function test_chunk172() public { _runOrSkip(172); }
    function test_chunk173() public { _runOrSkip(173); }
    function test_chunk174() public { _runOrSkip(174); }
    function test_chunk175() public { _runOrSkip(175); }
    function test_chunk176() public { _runOrSkip(176); }
    function test_chunk177() public { _runOrSkip(177); }
    function test_chunk178() public { _runOrSkip(178); }
    function test_chunk179() public { _runOrSkip(179); }
    function test_chunk180() public { _runOrSkip(180); }
    function test_chunk181() public { _runOrSkip(181); }
    function test_chunk182() public { _runOrSkip(182); }
    function test_chunk183() public { _runOrSkip(183); }
    function test_chunk184() public { _runOrSkip(184); }
    function test_chunk185() public { _runOrSkip(185); }
    function test_chunk186() public { _runOrSkip(186); }
    function test_chunk187() public { _runOrSkip(187); }
    function test_chunk188() public { _runOrSkip(188); }
    function test_chunk189() public { _runOrSkip(189); }
    function test_chunk190() public { _runOrSkip(190); }
    function test_chunk191() public { _runOrSkip(191); }
    function test_chunk192() public { _runOrSkip(192); }
    function test_chunk193() public { _runOrSkip(193); }
    function test_chunk194() public { _runOrSkip(194); }
    function test_chunk195() public { _runOrSkip(195); }
    function test_chunk196() public { _runOrSkip(196); }
    function test_chunk197() public { _runOrSkip(197); }
    function test_chunk198() public { _runOrSkip(198); }
    function test_chunk199() public { _runOrSkip(199); }
}
