import { ethers } from 'ethers';
import dotenv from 'dotenv';
dotenv.config({ path: './.env' });
const rpc = process.env.RPC_URL;
const contractAddress = process.env.CONTRACT_ADDRESS;
if (!rpc || !contractAddress) {
  console.error('RPC_URL or CONTRACT_ADDRESS missing in backend/.env');
  process.exit(2);
}
(async function(){
  const provider = new ethers.JsonRpcProvider(rpc);
  const contract = new ethers.Contract(contractAddress, [
    'function operator() view returns (address)',
    'function arenaCount() view returns (uint256)'
  ], provider);
  const op = await contract.operator();
  const count = (await contract.arenaCount()).toString();
  console.log(JSON.stringify({ contractAddress, operator: op, arenaCount: count }));
})();
