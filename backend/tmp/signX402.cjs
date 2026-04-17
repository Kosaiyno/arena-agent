#!/usr/bin/env node
const { Wallet, ethers } = require('ethers');

async function main() {
  const RPC = process.env.RPC_URL || 'https://rpc.xlayer.tech';
  const pk = process.env.PRIVATE_KEY;
  const args = process.argv.slice(2);
  if (args.length < 4) {
    console.error('Usage: node signX402.cjs <tokenAddress> <from> <to> <valueBaseUnits> [validWindowSecs=3600]');
    process.exit(2);
  }
  const [tokenAddress, from, to, valueBase] = args;
  const windowSecs = Number(process.argv[6] ?? 3600);

  const provider = new ethers.providers.JsonRpcProvider(RPC);
  const signer = new Wallet(pk, provider);

  const erc20 = new ethers.Contract(tokenAddress, [
    'function name() view returns (string)'
  ], provider);
  const name = (await erc20.name()).toString();
  const chainId = (await provider.getNetwork()).chainId;

  const domain = {
    name: name,
    version: '2',
    chainId: chainId,
    verifyingContract: tokenAddress,
  };

  const types = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  };

  const now = Math.floor(Date.now() / 1000);
  const validAfter = Math.max(0, now - 60);
  const validBefore = now + windowSecs;
  const nonce = ethers.utils.hexlify(ethers.utils.randomBytes(32));

  const message = {
    from,
    to,
    value: valueBase,
    validAfter: String(validAfter),
    validBefore: String(validBefore),
    nonce,
  };

  const signature = await signer._signTypedData(domain, types, message);

  const output = { authorization: message, signature };
  console.log(JSON.stringify(output));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
