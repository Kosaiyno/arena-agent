import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import dotenv from "dotenv";
dotenv.config();

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    hardhat: {},
    localhost: {
      url: "http://127.0.0.1:8545",
    },
    xlayer_testnet: {
      url: process.env.XLAYER_TESTNET_RPC_URL ?? "https://testrpc.xlayer.tech",
      chainId: 1952,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
    xlayer: {
      url: process.env.XLAYER_RPC_URL ?? "https://rpc.xlayer.tech",
      chainId: 196,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
  },
  etherscan: {
    apiKey: {
      xlayer_testnet: process.env.OKLINK_API_KEY ?? "",
      xlayer: process.env.OKLINK_API_KEY ?? "",
    },
    customChains: [
      {
        network: "xlayer_testnet",
        chainId: 1952,
        urls: {
          apiURL: "https://www.oklink.com/api/explorer/v1/contract/verify/async/api",
          browserURL: "https://www.oklink.com/xlayer-test",
        },
      },
      {
        network: "xlayer",
        chainId: 196,
        urls: {
          apiURL: "https://www.oklink.com/api/explorer/v1/contract/verify/async/api",
          browserURL: "https://www.oklink.com/xlayer",
        },
      },
    ],
  },
};

export default config;
