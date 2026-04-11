import { expect } from "chai";
import { ethers } from "hardhat";

describe("AgenticCompetitionEngine", () => {
  async function deployFixture() {
    const [operator, alice, bob, carol] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("AgenticCompetitionEngine");
    const contract = await factory.deploy(operator.address);
    await contract.waitForDeployment();

    return { contract, operator, alice, bob, carol };
  }

  it("creates arenas, tracks best scores, finalizes, and auto-pays winners", async () => {
    const { contract, alice, bob, carol } = await deployFixture();
    const entryFee = ethers.parseEther("0.1");

    await contract.createArena(entryFee, 60, ethers.ZeroAddress);

    await contract.connect(alice).joinArena(1, { value: entryFee });
    await contract.connect(bob).joinArena(1, { value: entryFee });
    await contract.connect(carol).joinArena(1, { value: entryFee });

    await contract.submitScore(1, alice.address, 10);
    await contract.submitScore(1, bob.address, 25);
    await contract.submitScore(1, carol.address, 20);
    await contract.submitScore(1, alice.address, 15);

    expect(await contract.bestScores(1, alice.address)).to.equal(15);

    await ethers.provider.send("evm_increaseTime", [61]);
    await ethers.provider.send("evm_mine", []);

    await contract.closeArena(1);

    const bobBalanceBefore = await ethers.provider.getBalance(bob.address);
    await contract.finalizeArena(1, [bob.address, carol.address, alice.address], [50, 30, 20]);
    const bobBalanceAfter = await ethers.provider.getBalance(bob.address);

    expect(await contract.rewardAmounts(1, bob.address)).to.equal(0n);
    expect(await contract.claimed(1, bob.address)).to.equal(true);
    expect(bobBalanceAfter - bobBalanceBefore).to.equal(ethers.parseEther("0.15"));
  });

  it("relays ERC20 joins after a one-time approval", async () => {
    const { contract, alice, bob } = await deployFixture();
    const tokenFactory = await ethers.getContractFactory("MockERC20");
    const usdc = await tokenFactory.deploy("USD Coin", "USDC", 6);
    await usdc.waitForDeployment();

    const entryFee = 500_000n;
    await usdc.mint(alice.address, 2_000_000n);
    await usdc.mint(bob.address, 2_000_000n);

    await contract.createArena(entryFee, 60, await usdc.getAddress());
    await usdc.connect(alice).approve(await contract.getAddress(), 2_000_000n);
    await usdc.connect(bob).approve(await contract.getAddress(), 2_000_000n);

    await contract.joinArenaFor(1, alice.address);
    await contract.joinArenaFor(1, bob.address);

    const arena = await contract.getArena(1);
    expect(arena[2]).to.equal(1_000_000n);
    expect(arena[8]).to.equal(2n);
  });

  it("joins ERC20 arenas via x402 authorization without standing allowance", async () => {
    const { contract, alice } = await deployFixture();
    const tokenFactory = await ethers.getContractFactory("MockX402ERC20");
    const usdc = await tokenFactory.deploy("USD Coin", "USDC", 6);
    await usdc.waitForDeployment();

    const entryFee = 500_000n;
    await usdc.mint(alice.address, 2_000_000n);

    await contract.createArena(entryFee, 60, await usdc.getAddress());

    const network = await ethers.provider.getNetwork();
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    const validBefore = BigInt(Math.floor(Date.now() / 1000) + 300);
    const authorization = {
      from: alice.address,
      to: await contract.getAddress(),
      value: entryFee,
      validAfter: 0,
      validBefore,
      nonce,
    };

    const signature = await alice.signTypedData(
      {
        name: "USD Coin",
        version: "2",
        chainId: network.chainId,
        verifyingContract: await usdc.getAddress(),
      },
      {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      authorization,
    );

    await contract.joinArenaWithAuthorization(1, authorization, signature);

    const arena = await contract.getArena(1);
    expect(arena[2]).to.equal(entryFee);
    expect(arena[8]).to.equal(1n);
    expect(await usdc.balanceOf(await contract.getAddress())).to.equal(entryFee);
  });
});
