import { ethers } from 'ethers';

async function main() {
  const RPC = process.env.RPC_URL || 'https://rpc.xlayer.tech';
  const pk = process.env.PRIVATE_KEY;
  const args = process.argv.slice(2);
  if (args.length < 4) {
    console.error('Usage: node signX402.mjs <tokenAddress> <from> <to> <valueBaseUnits> [validWindowSecs=3600]');
    process.exit(2);
  }
  const [tokenAddress, from, to, valueBase] = args;
  const windowSecs = Number(args[4] ?? 3600);

  const provider = new ethers.JsonRpcProvider(RPC);
  const signer = new ethers.Wallet(pk, provider);

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
  const nonce = ethers.hexlify(ethers.randomBytes(32));

  const message = {
    from,
    to,
    value: valueBase,
    validAfter: String(validAfter),
    validBefore: String(validBefore),
    nonce,
  };

  // ethers v6 uses `signTypedData`; `_signTypedData` is an ethers v5 internal API
  const signature = await signer.signTypedData(domain, types, message);

  const output = { authorization: message, signature };
  console.log(JSON.stringify(output));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
