import { IncomingHttpHeaders } from "http";
import { env } from "../config/env.js";
import { TokenInfo } from "../types/arena.js";

type X402AcceptedOption = {
  scheme: "exact";
  network: string;
  amount: string;
  payTo: string;
  asset: string;
  maxTimeoutSeconds: number;
  extra: {
    name: string;
    version: string;
    arenaId: number;
  };
};

export type OkxX402Challenge = {
  supported: boolean;
  reason?: string;
  x402Version?: number;
  resource?: {
    url: string;
    description: string;
    mimeType: string;
  };
  accepts?: X402AcceptedOption[];
  requiredHeaderName?: string;
  requiredHeaderValue?: string;
};

export type ParsedOkxX402Payment = {
  headerName: "payment-signature" | "x-payment";
  x402Version: number;
  network?: string;
  amount?: string;
  asset?: string;
  payTo?: string;
  signature?: string;
  authorization?: {
    from: string;
    to: string;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: string;
  };
};

export class OkxX402Service {
  isEnabled(): boolean {
    return env.x402Enabled;
  }

  buildChallenge(params: {
    arenaId: number;
    entryFee: string;
    settlementToken?: TokenInfo;
    resourcePath: string;
  }): OkxX402Challenge {
    const token = params.settlementToken;
    if (!token?.address || token.kind !== "erc20") {
      return {
        supported: false,
        reason: "OKX x402 signing is only exposed for ERC-20 settlement tokens in this deployment.",
      };
    }

    const accepted: X402AcceptedOption = {
      scheme: "exact",
      network: `eip155:${env.appChainId}`,
      amount: params.entryFee,
      payTo: env.contractAddress,
      asset: token.address,
      maxTimeoutSeconds: 300,
      extra: {
        name: token.name,
        version: "2",
        arenaId: params.arenaId,
      },
    };

    const payload = {
      x402Version: 2,
      error: "PAYMENT-SIGNATURE header is required",
      resource: {
        url: params.resourcePath,
        description: `Arena #${params.arenaId} entry authorization`,
        mimeType: "application/json",
      },
      accepts: [accepted],
    };

    return {
      supported: true,
      x402Version: 2,
      resource: payload.resource,
      accepts: [accepted],
      requiredHeaderName: "PAYMENT-SIGNATURE",
      requiredHeaderValue: Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
    };
  }

  parsePaymentHeaders(headers: IncomingHttpHeaders): ParsedOkxX402Payment | null {
    const paymentSignature = this.getHeaderValue(headers["payment-signature"]);
    if (paymentSignature) {
      const decoded = this.decodeBase64Json(paymentSignature);
      if (!decoded || typeof decoded !== "object") {
        return null;
      }

      const payload = decoded as {
        x402Version?: number;
        accepted?: { network?: string; amount?: string; asset?: string; payTo?: string };
        payload?: {
          signature?: string;
          authorization?: {
            from?: string;
            to?: string;
            value?: string;
            validAfter?: string;
            validBefore?: string;
            nonce?: string;
          };
        };
      };
      if (!payload.x402Version || !payload.accepted) {
        return null;
      }

      const authorization = payload.payload?.authorization;
      const signature = payload.payload?.signature;

      return {
        headerName: "payment-signature",
        x402Version: payload.x402Version,
        network: payload.accepted.network,
        amount: payload.accepted.amount,
        asset: payload.accepted.asset,
        payTo: payload.accepted.payTo,
        signature,
        authorization: authorization && authorization.from && authorization.to && authorization.value && authorization.validAfter && authorization.validBefore && authorization.nonce
          ? {
            from: authorization.from,
            to: authorization.to,
            value: authorization.value,
            validAfter: authorization.validAfter,
            validBefore: authorization.validBefore,
            nonce: authorization.nonce,
          }
          : undefined,
      };
    }

    const legacyPayment = this.getHeaderValue(headers["x-payment"]);
    if (!legacyPayment) {
      return null;
    }

    const decoded = this.decodeBase64Json(legacyPayment);
    if (!decoded || typeof decoded !== "object") {
      return null;
    }

    const payload = decoded as {
      x402Version?: number;
      network?: string;
        payload?: {
          signature?: string;
          authorization?: {
            from?: string;
            to?: string;
            value?: string;
            validAfter?: string;
            validBefore?: string;
            nonce?: string;
          };
        };
    };
    if (!payload.x402Version) {
      return null;
    }

      const authorization = payload.payload?.authorization;

    return {
      headerName: "x-payment",
      x402Version: payload.x402Version,
      network: payload.network,
        amount: authorization?.value,
        payTo: authorization?.to,
        signature: payload.payload?.signature,
        authorization: authorization && authorization.from && authorization.to && authorization.value && authorization.validAfter && authorization.validBefore && authorization.nonce
          ? {
            from: authorization.from,
            to: authorization.to,
            value: authorization.value,
            validAfter: authorization.validAfter,
            validBefore: authorization.validBefore,
            nonce: authorization.nonce,
          }
          : undefined,
    };
  }

  private getHeaderValue(value: string | string[] | undefined): string | null {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    return null;
  }

  private decodeBase64Json(value: string): unknown {
    try {
      return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
    } catch {
      return null;
    }
  }
}