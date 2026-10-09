// Register and export all strategies for the engine
import strategyEngine from "./strategyEngine.js";
import { momentumStrategy } from "./momentumStrategy.js";
import { breakoutStrategy } from "./breakoutStrategy.js";
import { liquidityGrowthStrategy } from "./liquidityGrowthStrategy.js";
import { meanReversionStrategy } from "./meanReversionStrategy.js";
import { sniperStrategy } from "./sniperStrategy.js";
import { copyTradingStrategy } from "./copyTradingStrategy.js";

strategyEngine.register(momentumStrategy);
strategyEngine.register(breakoutStrategy);
strategyEngine.register(liquidityGrowthStrategy);
strategyEngine.register(meanReversionStrategy);
strategyEngine.register(sniperStrategy);
strategyEngine.register(copyTradingStrategy);

export default strategyEngine;
