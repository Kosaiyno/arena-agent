export class PayoutService {
  static getNormalizedPayouts(defaultPayouts: number[], winnerCount: number): number[] {
    const payoutSlice = defaultPayouts.slice(0, winnerCount);
    const payoutTotal = payoutSlice.reduce((total, value) => total + value, 0);

    return payoutSlice.map((value, index) => {
      if (index === payoutSlice.length - 1) {
        return 100 - payoutSlice.slice(0, -1).reduce((total, item) => total + Math.floor((item * 100) / payoutTotal), 0);
      }

      return Math.floor((value * 100) / payoutTotal);
    });
  }

  static describe(defaultPayouts: number[], winnerCount: number): string {
    const normalized = this.getNormalizedPayouts(defaultPayouts, winnerCount);
    return normalized.map((value, index) => `#${index + 1}: ${value}%`).join(", ");
  }
}