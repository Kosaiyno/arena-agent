import { Wallet, ethers } from 'ethers';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config({ path: './.env' });
const pk = process.env.PRIVATE_KEY;
const rpc = process.env.RPC_URL || 'https://rpc.xlayer.tech';
if (!pk) {
  console.error('PRIVATE_KEY not set in backend/.env');
  process.exit(2);
}
(async function(){
  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(pk, provider);
  const address = await wallet.getAddress();
  const bal = await provider.getBalance(address);
  console.log(JSON.stringify({ address, balance: bal.toString(), rpc }));
})();
