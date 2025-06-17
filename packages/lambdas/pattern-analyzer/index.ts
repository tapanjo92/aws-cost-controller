import { DynamoDB } from 'aws-sdk';
import { DateTime } from 'luxon';

const dynamodb = new DynamoDB.DocumentClient({ region: process.env.AWS_REGION });

interface ServicePattern {
  accountId: string;
  service: string;
  weeklyPattern: number[];
  monthlyPattern: number[];
  seasonalFactors: Record<string, number>;
  growthRate: number;
  volatility: number;
  lastUpdated: number;
}

export const handler = async (): Promise<void> => {
  console.log('Starting pattern analysis');
  
  try {
    // Get all unique account/service combinations
    const combinations = await getAccountServiceCombinations();
    
    // Analyze patterns for each combination
    for (const combo of combinations) {
      await analyzeServicePattern(combo.accountId, combo.service);
    }
    
    console.log(`Pattern analysis completed for ${combinations.length} combinations`);
    
  } catch (error) {
    console.error('Pattern analysis failed:', error);
    throw error;
  }
};

async function getAccountServiceCombinations(): Promise<Array<{accountId: string, service: string}>> {
  const combinations = new Set<string>();
  let lastEvaluatedKey;
  
  // Scan for unique combinations (in production, use a more efficient method)
  do {
    const params: any = {
      TableName: process.env.COST_TABLE_NAME!,
      ProjectionExpression: 'accountId, service',
      Limit: 1000
    };
    
    if (lastEvaluatedKey) {
      params.ExclusiveStartKey = lastEvaluatedKey;
    }
    
    const result = await dynamodb.scan(params).promise();
    
    result.Items?.forEach(item => {
      combinations.add(`${item.accountId}#${item.service}`);
    });
    
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);
  
  return Array.from(combinations).map(combo => {
    const [accountId, service] = combo.split('#');
    return { accountId, service };
  });
}

async function analyzeServicePattern(accountId: string, service: string): Promise<void> {
  // Get 90 days of historical data
  const ninetyDaysAgo = Date.now() - (90 * 24 * 60 * 60 * 1000);
  
  const params = {
    TableName: process.env.COST_TABLE_NAME!,
    IndexName: 'TimeSeries',
    KeyConditionExpression: 'accountId = :accountId AND #ts > :start',
    FilterExpression: 'service = :service',
    ExpressionAttributeNames: {
      '#ts': 'timestamp'
    },
    ExpressionAttributeValues: {
      ':accountId': accountId,
      ':service': service,
      ':start': ninetyDaysAgo
    }
  };
  
  const result = await dynamodb.query(params).promise();
  const data = result.Items || [];
  
  if (data.length < 14) {
    console.log(`Insufficient data for ${accountId}/${service}`);
    return;
  }
  
  // Analyze patterns
  const weeklyPattern = calculateWeeklyPattern(data);
  const monthlyPattern = calculateMonthlyPattern(data);
  const seasonalFactors = calculateSeasonalFactors(data);
  const growthRate = calculateGrowthRate(data);
  const volatility = calculateVolatility(data);
  
  // Store pattern analysis
  const pattern: ServicePattern = {
    accountId,
    service,
    weeklyPattern,
    monthlyPattern,
    seasonalFactors,
    growthRate,
    volatility,
    lastUpdated: Date.now()
  };
  
  await storePattern(pattern);
  
  console.log(`Pattern analyzed for ${accountId}/${service}`, {
    growthRate: `${(growthRate * 100).toFixed(2)}%`,
    volatility: volatility.toFixed(2)
  });
}

function calculateWeeklyPattern(data: any[]): number[] {
  // Calculate average cost for each day of week
  const dayTotals: Record<number, { sum: number; count: number }> = {};
  
  for (let i = 0; i < 7; i++) {
    dayTotals[i] = { sum: 0, count: 0 };
  }
  
  data.forEach(item => {
    const dayOfWeek = new Date(item.timestamp).getDay();
    dayTotals[dayOfWeek].sum += item.cost;
    dayTotals[dayOfWeek].count += 1;
  });
  
  return Array.from({ length: 7 }, (_, i) => 
    dayTotals[i].count > 0 ? dayTotals[i].sum / dayTotals[i].count : 0
  );
}

function calculateMonthlyPattern(data: any[]): number[] {
  // Calculate average cost for each day of month
  const dayTotals: Record<number, { sum: number; count: number }> = {};
  
  for (let i = 1; i <= 31; i++) {
    dayTotals[i] = { sum: 0, count: 0 };
  }
  
  data.forEach(item => {
    const dayOfMonth = new Date(item.timestamp).getDate();
    dayTotals[dayOfMonth].sum += item.cost;
    dayTotals[dayOfMonth].count += 1;
  });
  
  return Array.from({ length: 31 }, (_, i) => {
    const day = i + 1;
    return dayTotals[day].count > 0 ? dayTotals[day].sum / dayTotals[day].count : 0;
  });
}

function calculateSeasonalFactors(data: any[]): Record<string, number> {
  // Simple seasonal factors by month
  const monthlyAverages: Record<number, { sum: number; count: number }> = {};
  
  data.forEach(item => {
    const month = new Date(item.timestamp).getMonth();
    if (!monthlyAverages[month]) {
      monthlyAverages[month] = { sum: 0, count: 0 };
    }
    monthlyAverages[month].sum += item.cost;
    monthlyAverages[month].count += 1;
  });
  
  const overallAverage = data.reduce((sum, item) => sum + item.cost, 0) / data.length;
  const factors: Record<string, number> = {};
  
  Object.entries(monthlyAverages).forEach(([month, stats]) => {
    const monthAverage = stats.sum / stats.count;
    factors[month] = monthAverage / overallAverage;
  });
  
  return factors;
}

function calculateGrowthRate(data: any[]): number {
  // Simple linear regression for growth rate
  if (data.length < 2) return 0;
  
  // Sort by timestamp
  const sorted = data.sort((a, b) => a.timestamp - b.timestamp);
  
  // Calculate daily averages
  const dailyData: Record<string, { sum: number; count: number }> = {};
  
  sorted.forEach(item => {
    const date = DateTime.fromMillis(item.timestamp).toISODate()!;
    if (!dailyData[date]) {
      dailyData[date] = { sum: 0, count: 0 };
    }
    dailyData[date].sum += item.cost;
    dailyData[date].count += 1;
  });
  
  const dailyAverages = Object.entries(dailyData)
    .map(([date, stats]) => ({
      date,
      cost: stats.sum / stats.count
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
  
  if (dailyAverages.length < 2) return 0;
  
  // Simple growth calculation: (last week avg - first week avg) / first week avg
  const firstWeek = dailyAverages.slice(0, 7).reduce((sum, d) => sum + d.cost, 0) / 7;
  const lastWeek = dailyAverages.slice(-7).reduce((sum, d) => sum + d.cost, 0) / 7;
  
  const totalDays = dailyAverages.length;
  const dailyGrowthRate = (lastWeek - firstWeek) / firstWeek / totalDays;
  
  return dailyGrowthRate;
}

function calculateVolatility(data: any[]): number {
  if (data.length < 2) return 0;
  
  const costs = data.map(item => item.cost);
  const mean = costs.reduce((sum, cost) => sum + cost, 0) / costs.length;
  const variance = costs.reduce((sum, cost) => sum + Math.pow(cost - mean, 2), 0) / costs.length;
  const stdDev = Math.sqrt(variance);
  
  // Coefficient of variation (CV) as volatility measure
  return mean > 0 ? stdDev / mean : 0;
}

async function storePattern(pattern: ServicePattern): Promise<void> {
  const params = {
    TableName: process.env.THRESHOLDS_TABLE_NAME!,
    Item: {
      pk: `PATTERN#${pattern.accountId}`,
      sk: `${pattern.service}`,
      ...pattern,
      ttl: Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60) // 1 year retention
    }
  };
  
  await dynamodb.put(params).promise();
}
