import { ethers } from 'ethers';
import dotenv from 'dotenv';

dotenv.config({ path: './.env' });
const rpc = process.env.RPC_URL;
const contractAddress = process.env.CONTRACT_ADDRESS;
if (!rpc || !contractAddress) {
  console.error('Missing RPC_URL or CONTRACT_ADDRESS in backend/.env');
  process.exit(2);
}
(async function(){
  const provider = new ethers.JsonRpcProvider(rpc);
  const contract = new ethers.Contract(contractAddress, [
    'function rewardAmounts(uint256,address) view returns (uint256)'
  ], provider);
  const arenaId = 10;
  const winner = '0x2f5fc4f223875b5F453C5534C50f926b114091B7';
  const amt = await contract.rewardAmounts(arenaId, winner);
  console.log(JSON.stringify({ arenaId, winner, rewardAmount: amt.toString() }));
})();
