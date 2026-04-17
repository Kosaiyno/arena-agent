// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Minimal {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IERC20X402 {
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

contract AgenticCompetitionEngine {
    struct TransferAuthorization {
        address from;
        address to;
        uint256 value;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
    }

    struct Arena {
        uint256 id;
        uint256 entryFee;
        uint256 totalPool;
        uint64 createdAt;
        uint64 endTime;
        bool closed;
        bool finalized;
        address entryToken;
        address[] players;
    }

    uint256 public arenaCount;
    address public immutable operator;

    mapping(uint256 => Arena) private arenas;
    mapping(uint256 => mapping(address => bool)) public hasJoined;
    mapping(uint256 => mapping(address => uint256)) public bestScores;
    mapping(uint256 => mapping(address => uint256)) public rewardAmounts;
    mapping(uint256 => mapping(address => bool)) public claimed;
    mapping(uint256 => address[]) private arenaWinners;
    mapping(bytes32 => bool) public authorizationUsed;

    event ArenaCreated(uint256 indexed arenaId, uint256 entryFee, uint256 duration, uint256 endTime);
    event ArenaJoined(uint256 indexed arenaId, address indexed player, uint256 totalPool);
    event ScoreSubmitted(uint256 indexed arenaId, address indexed player, uint256 score);
    event ArenaClosed(uint256 indexed arenaId);
    event ArenaFinalized(uint256 indexed arenaId, address[] winners, uint256[] percentages);
    event RewardPaid(uint256 indexed arenaId, address indexed player, uint256 amount);
    event RewardStored(uint256 indexed arenaId, address indexed player, uint256 amount);
    event RewardClaimed(uint256 indexed arenaId, address indexed player, uint256 amount);
    event ArenaJoinedWithAuthorization(uint256 indexed arenaId, address indexed player, bytes32 indexed nonce, uint256 totalPool);
    event AuthorizationConsumed(uint256 indexed arenaId, address indexed sponsor, address indexed recipient, bytes32 nonce, uint256 amount);

    error OnlyOperator();
    error ArenaMissing();
    error InvalidDuration();
    error ArenaClosedAlready();
    error ArenaStillOpen();
    error ArenaNotClosed();
    error ArenaAlreadyFinalized();
    error WrongEntryFee();
    error InvalidPercentageSplit();
    error NotArenaPlayer();
    error NothingToClaim();
    error AlreadyJoined();
    error TokenTransferFailed();
    error InvalidJoinMethod();
    error InvalidAuthorization();
    error InvalidSignature();

    modifier onlyOperator() {
        if (msg.sender != operator) revert OnlyOperator();
        _;
    }

    modifier existingArena(uint256 arenaId) {
        if (arenaId == 0 || arenaId > arenaCount) revert ArenaMissing();
        _;
    }

    constructor(address operatorAddress) {
        operator = operatorAddress;
    }

    function createArena(uint256 entryFee, uint256 duration, address entryToken) external onlyOperator returns (uint256 arenaId) {
        if (duration == 0) revert InvalidDuration();

        arenaId = ++arenaCount;
        Arena storage arena = arenas[arenaId];
        arena.id = arenaId;
        arena.entryFee = entryFee;
        arena.createdAt = uint64(block.timestamp);
        arena.endTime = uint64(block.timestamp + duration);
        arena.entryToken = entryToken;

        emit ArenaCreated(arenaId, entryFee, duration, arena.endTime);
    }

    function joinArena(uint256 arenaId) external payable existingArena(arenaId) {
        Arena storage arena = arenas[arenaId];
        if (arena.closed || block.timestamp >= arena.endTime) revert ArenaClosedAlready();
        if (arena.entryToken != address(0)) revert InvalidJoinMethod();
        if (hasJoined[arenaId][msg.sender]) revert AlreadyJoined();
        if (msg.value != arena.entryFee) revert WrongEntryFee();

        hasJoined[arenaId][msg.sender] = true;
        arena.players.push(msg.sender);

        arena.totalPool += msg.value;
        emit ArenaJoined(arenaId, msg.sender, arena.totalPool);
    }

    function joinArenaFor(uint256 arenaId, address player) external onlyOperator existingArena(arenaId) {
        Arena storage arena = arenas[arenaId];
        if (arena.closed || block.timestamp >= arena.endTime) revert ArenaClosedAlready();
        if (arena.entryToken == address(0)) revert InvalidJoinMethod();
        if (hasJoined[arenaId][player]) revert AlreadyJoined();

        bool success = IERC20Minimal(arena.entryToken).transferFrom(player, address(this), arena.entryFee);
        if (!success) revert TokenTransferFailed();

        hasJoined[arenaId][player] = true;
        arena.players.push(player);
        arena.totalPool += arena.entryFee;
        emit ArenaJoined(arenaId, player, arena.totalPool);
    }

    function joinArenaWithAuthorization(
        uint256 arenaId,
        TransferAuthorization calldata authorization,
        bytes calldata signature
    ) external onlyOperator existingArena(arenaId) {
        Arena storage arena = arenas[arenaId];
        if (arena.closed || block.timestamp >= arena.endTime) revert ArenaClosedAlready();
        if (arena.entryToken == address(0)) revert InvalidJoinMethod();
        if (hasJoined[arenaId][authorization.from]) revert AlreadyJoined();
        if (authorization.to != address(this)) revert InvalidAuthorization();
        if (authorization.value != arena.entryFee) revert WrongEntryFee();
        if (block.timestamp < authorization.validAfter || block.timestamp > authorization.validBefore) revert InvalidAuthorization();

        (uint8 v, bytes32 r, bytes32 s) = _splitSignature(signature);
        IERC20X402(arena.entryToken).transferWithAuthorization(
            authorization.from,
            authorization.to,
            authorization.value,
            authorization.validAfter,
            authorization.validBefore,
            authorization.nonce,
            v,
            r,
            s
        );

        hasJoined[arenaId][authorization.from] = true;
        arena.players.push(authorization.from);
        arena.totalPool += arena.entryFee;

        emit ArenaJoined(arenaId, authorization.from, arena.totalPool);
        emit ArenaJoinedWithAuthorization(arenaId, authorization.from, authorization.nonce, arena.totalPool);
    }

    function submitScore(uint256 arenaId, address player, uint256 score) external onlyOperator existingArena(arenaId) {
        Arena storage arena = arenas[arenaId];
        if (arena.closed || block.timestamp >= arena.endTime) revert ArenaClosedAlready();
        if (!hasJoined[arenaId][player]) revert NotArenaPlayer();
        if (score > bestScores[arenaId][player]) {
            bestScores[arenaId][player] = score;
            emit ScoreSubmitted(arenaId, player, score);
        }
    }

    function closeArena(uint256 arenaId) external onlyOperator existingArena(arenaId) {
        Arena storage arena = arenas[arenaId];
        if (arena.closed) revert ArenaClosedAlready();
        if (block.timestamp < arena.endTime) revert ArenaStillOpen();

        arena.closed = true;
        emit ArenaClosed(arenaId);
    }

    function finalizeArena(
        uint256 arenaId,
        address[] calldata winners,
        uint256[] calldata percentages
    ) external onlyOperator existingArena(arenaId) {
        Arena storage arena = arenas[arenaId];
        if (!arena.closed) revert ArenaNotClosed();
        if (arena.finalized) revert ArenaAlreadyFinalized();
        if (winners.length == 0 || winners.length != percentages.length || winners.length > 3) {
            revert InvalidPercentageSplit();
        }

        uint256 totalPercentage;
        for (uint256 index = 0; index < winners.length; index++) {
            if (!hasJoined[arenaId][winners[index]]) revert NotArenaPlayer();
            totalPercentage += percentages[index];
        }
        if (totalPercentage != 100) revert InvalidPercentageSplit();

        arena.finalized = true;
        for (uint256 index = 0; index < winners.length; index++) {
            uint256 reward = (arena.totalPool * percentages[index]) / 100;
            address winner = winners[index];
            arenaWinners[arenaId].push(winner);

            bool success = _payout(arena.entryToken, winner, reward);
            if (success) {
                claimed[arenaId][winner] = true;
                emit RewardPaid(arenaId, winner, reward);
            } else {
                rewardAmounts[arenaId][winner] = reward;
                emit RewardStored(arenaId, winner, reward);
            }
        }

        emit ArenaFinalized(arenaId, winners, percentages);
    }

    // Sponsor-signed x402-style payout authorization consumption.
    // Allows the operator (agent) to submit a sponsor authorization to pay a winner.
    function payWinnerWithAuthorization(
        uint256 arenaId,
        address winner,
        TransferAuthorization calldata authorization,
        bytes calldata signature
    ) external onlyOperator existingArena(arenaId) {
        Arena storage arena = arenas[arenaId];
        if (arena.entryToken == address(0)) revert InvalidAuthorization();

        if (authorization.to != winner) revert InvalidAuthorization();
        if (authorization.value == 0) revert InvalidAuthorization();
        if (block.timestamp < authorization.validAfter || block.timestamp > authorization.validBefore) revert InvalidAuthorization();

        bytes32 nonce = authorization.nonce;
        if (authorizationUsed[nonce]) revert InvalidAuthorization();

        (uint8 v, bytes32 r, bytes32 s) = _splitSignature(signature);

        // Perform the x402 transfer from sponsor -> winner using the arena's entry token
        IERC20X402(arena.entryToken).transferWithAuthorization(
            authorization.from,
            authorization.to,
            authorization.value,
            authorization.validAfter,
            authorization.validBefore,
            authorization.nonce,
            v,
            r,
            s
        );

        authorizationUsed[nonce] = true;

        // If a stored reward exists for this winner, clear it; otherwise we still emit paid event
        if (rewardAmounts[arenaId][winner] > 0) {
            rewardAmounts[arenaId][winner] = 0;
            claimed[arenaId][winner] = true;
        }

        emit AuthorizationConsumed(arenaId, authorization.from, winner, nonce, authorization.value);
        emit RewardPaid(arenaId, winner, authorization.value);
    }

    function claim(uint256 arenaId) external existingArena(arenaId) {
        Arena storage arena = arenas[arenaId];
        if (!arena.finalized) revert ArenaNotClosed();
        if (claimed[arenaId][msg.sender]) revert NothingToClaim();

        uint256 reward = rewardAmounts[arenaId][msg.sender];
        if (reward == 0) revert NothingToClaim();

        claimed[arenaId][msg.sender] = true;
        rewardAmounts[arenaId][msg.sender] = 0;

        if (!_payout(arena.entryToken, msg.sender, reward)) {
            rewardAmounts[arenaId][msg.sender] = reward;
            claimed[arenaId][msg.sender] = false;
            revert TokenTransferFailed();
        }

        emit RewardClaimed(arenaId, msg.sender, reward);
    }

    function getArena(uint256 arenaId)
        external
        view
        existingArena(arenaId)
        returns (
            uint256 id,
            uint256 entryFee,
            uint256 totalPool,
            uint64 createdAt,
            uint64 endTime,
            bool closed,
            bool finalized,
            address entryToken,
            uint256 playerCount
        )
    {
        Arena storage arena = arenas[arenaId];
        return (
            arena.id,
            arena.entryFee,
            arena.totalPool,
            arena.createdAt,
            arena.endTime,
            arena.closed,
            arena.finalized,
            arena.entryToken,
            arena.players.length
        );
    }

    function getArenaPlayers(uint256 arenaId) external view existingArena(arenaId) returns (address[] memory) {
        return arenas[arenaId].players;
    }

    function getArenaWinners(uint256 arenaId) external view existingArena(arenaId) returns (address[] memory) {
        return arenaWinners[arenaId];
    }

    function _payout(address entryToken, address recipient, uint256 amount) private returns (bool) {
        if (amount == 0) return true;
        if (entryToken == address(0)) {
            (bool success, ) = payable(recipient).call{value: amount}("");
            return success;
        }
        return IERC20Minimal(entryToken).transfer(recipient, amount);
    }

    function _splitSignature(bytes calldata signature) private pure returns (uint8 v, bytes32 r, bytes32 s) {
        if (signature.length != 65) revert InvalidSignature();

        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }

        if (v < 27) {
            v += 27;
        }
        if (v != 27 && v != 28) revert InvalidSignature();
    }
}
