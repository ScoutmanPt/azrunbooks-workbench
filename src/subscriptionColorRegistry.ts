/**
 * Assigns a unique VS Code ThemeColor token to each Azure subscription.
 * Shared between the tree view and the workspace folder decoration provider
 * so both always agree on which color belongs to which subscription.
 */

export const SUBSCRIPTION_COLORS = [
  'charts.blue',
  'charts.green',
  'charts.yellow',
  'charts.orange',
  'charts.red',
  'charts.purple',
  'terminal.ansiCyan',
  'terminal.ansiMagenta',
  'terminal.ansiBrightGreen',
  'terminal.ansiBrightYellow',
  'terminal.ansiBrightBlue',
  'terminal.ansiBrightMagenta',
];

export class SubscriptionColorRegistry {
  private readonly colorMap = new Map<string, string>();

  getColor(subscriptionId: string): string {
    if (!this.colorMap.has(subscriptionId)) {
      const used = new Set(this.colorMap.values());
      const next =
        SUBSCRIPTION_COLORS.find(c => !used.has(c)) ??
        SUBSCRIPTION_COLORS[this.colorMap.size % SUBSCRIPTION_COLORS.length];
      this.colorMap.set(subscriptionId, next);
    }
    return this.colorMap.get(subscriptionId)!;
  }
}
