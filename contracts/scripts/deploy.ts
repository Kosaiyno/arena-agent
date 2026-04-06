import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  const factory = await ethers.getContractFactory("AgenticCompetitionEngine");
  const contract = await factory.deploy(deployer.address);
  await contract.waitForDeployment();

  console.log("AgenticCompetitionEngine deployed to:", await contract.getAddress());
  console.log("Operator:", deployer.address);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
