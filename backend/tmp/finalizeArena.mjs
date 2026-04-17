import { ethers } from 'ethers';
import dotenv from 'dotenv';

dotenv.config({ path: './.env' });
const rpc = process.env.RPC_URL;
const pk = process.env.PRIVATE_KEY;
const contractAddress = process.env.CONTRACT_ADDRESS;
if (!rpc || !pk || !contractAddress) {
  console.error('Missing RPC_URL, PRIVATE_KEY, or CONTRACT_ADDRESS in backend/.env');
  process.exit(2);
}
(async function(){
  const provider = new ethers.JsonRpcProvider(rpc);
  const signer = new ethers.Wallet(pk, provider);
  const contract = new ethers.Contract(contractAddress, [
    'function finalizeArena(uint256,address[],uint256[]) external',
  ], signer);
  const arenaId = 10;
  const winners = ['0x2f5fc4f223875b5F453C5534C50f926b114091B7'];
  const percentages = [100];
  try {
    const tx = await contract.finalizeArena(arenaId, winners, percentages);
    console.log('tx hash', tx.hash);
    const receipt = await tx.wait();
    console.log('receipt', receipt.transactionHash, receipt.status);
  } catch (err) {
    console.error('finalize failed:', err?.toString?.() ?? String(err));
    process.exit(1);
  }
})();
