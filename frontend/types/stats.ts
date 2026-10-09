export interface StatsResponse {
  success: boolean;
  portfolioValue: number;
  totalProfitSol: number;
  totalProfitPercent: number;
  openTrades: number;
  tradeVolumeSol: number;
  winRate: number;
  lastUpdated: string;
}
