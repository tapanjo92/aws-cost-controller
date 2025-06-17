import { DynamoDB, EventBridge, CloudWatch } from 'aws-sdk';
import { DateTime } from 'luxon';
import { EventBridgeEvent } from 'aws-lambda';

const dynamodb = new DynamoDB.DocumentClient({ region: process.env.AWS_REGION });
const eventbridge = new EventBridge({ region: process.env.AWS_REGION });
const cloudwatch = new CloudWatch({ region: process.env.AWS_REGION });

interface CostEvent {
  accountId: string;
  accountName: string;
  service: string;
  totalCost: number;
  records: Array<{
    cost: number;
    timestamp: number;
    region: string;
  }>;
}

interface AnomalyThreshold {
  mean: number;
  stdDev: number;
  samples: number;
  weeklyPattern?: number[];
  lastUpdated: number;
}

interface AnomalyResult {
  isAnomaly: boolean;
  score: number;
  expectedCost: number;
  actualCost: number;
  deviation: number;
  deviationPercentage: number;
  reasons: string[];
}

export const handler = async (event: EventBridgeEvent<string, string>): Promise<void> => {
  console.log('Processing cost event for anomaly detection', { 
    source: event.source,
    detailType: event['detail-type']
  });

  try {
    const costEvent: CostEvent = JSON.parse(event.detail);
    
    // Process each cost record for anomalies
    for (const record of costEvent.records) {
      const anomalyResult = await detectAnomaly(
        costEvent.accountId,
        costEvent.accountName,
        costEvent.service,
        record.cost,
        record.timestamp,
        record.region
      );
      
      if (anomalyResult.isAnomaly) {
        await handleAnomaly(costEvent, record, anomalyResult);
      }
      
      // Update the cost record with anomaly status
      await updateCostRecord(
        costEvent.accountId,
        costEvent.service,
        record.timestamp,
        record.region,
        anomalyResult
      );
    }
    
    // Send CloudWatch metrics
    await publishMetrics(costEvent.accountId, costEvent.service);
    
  } catch (error) {
    console.error('Error processing cost event:', error);
    throw error;
  }
};

async function detectAnomaly(
  accountId: string,
  accountName: string,
  service: string,
  currentCost: number,
  timestamp: number,
  region: string
): Promise<AnomalyResult> {
  // Get historical data and thresholds
  const [historicalData, threshold] = await Promise.all([
    getHistoricalData(accountId, service, timestamp, region),
    getThreshold(accountId, service, new Date(timestamp).getHours())
  ]);
  
  // If we don't have enough historical data, learn from this data point
  if (historicalData.length < 7) {
    await updateThreshold(accountId, service, currentCost, timestamp);
    return {
      isAnomaly: false,
      score: 0,
      expectedCost: currentCost,
      actualCost: currentCost,
      deviation: 0,
      deviationPercentage: 0,
      reasons: ['Insufficient historical data']
    };
  }
  
  // Calculate statistics if we don't have a threshold
  const stats = threshold || calculateStatistics(historicalData);
  
  // Detect anomaly using multiple methods
  const anomalyChecks = [
    checkStatisticalAnomaly(currentCost, stats),
    checkPercentageSpike(currentCost, historicalData),
    checkAbsoluteThreshold(currentCost, service),
    checkWeeklyPattern(currentCost, timestamp, stats)
  ];
  
  // Combine results
  const maxScore = Math.max(...anomalyChecks.map(check => check.score));
  const reasons = anomalyChecks
    .filter(check => check.score > 0.5)
    .map(check => check.reason);
  
  const result: AnomalyResult = {
    isAnomaly: maxScore > 0.95,
    score: maxScore,
    expectedCost: stats.mean,
    actualCost: currentCost,
    deviation: Math.abs(currentCost - stats.mean),
    deviationPercentage: ((currentCost - stats.mean) / stats.mean) * 100,
    reasons
  };
  
  // Update threshold with new data
  await updateThreshold(accountId, service, currentCost, timestamp);
  
  return result;
}

async function getHistoricalData(
  accountId: string,
  service: string,
  currentTimestamp: number,
  region: string
): Promise<number[]> {
  const hourOfDay = new Date(currentTimestamp).getHours();
  const thirtyDaysAgo = currentTimestamp - (30 * 24 * 60 * 60 * 1000);
  
  const params = {
    TableName: process.env.COST_TABLE_NAME!,
    IndexName: 'TimeSeries',
    KeyConditionExpression: 'accountId = :accountId AND #ts BETWEEN :start AND :end',
    FilterExpression: 'service = :service AND #region = :region AND #hour = :hour',
    ExpressionAttributeNames: {
      '#ts': 'timestamp',
      '#region': 'region',
      '#hour': 'hour'
    },
    ExpressionAttributeValues: {
      ':accountId': accountId,
      ':service': service,
      ':region': region,
      ':hour': hourOfDay,
      ':start': thirtyDaysAgo,
      ':end': currentTimestamp
    },
    Limit: 30
  };
  
  const result = await dynamodb.query(params).promise();
  
  return (result.Items || [])
    .map(item => item.cost)
    .filter(cost => cost > 0);
}

async function getThreshold(
  accountId: string,
  service: string,
  hour: number
): Promise<AnomalyThreshold | null> {
  const params = {
    TableName: process.env.THRESHOLDS_TABLE_NAME!,
    Key: {
      pk: `THRESHOLD#${accountId}`,
      sk: `${service}#${hour}`
    }
  };
  
  const result = await dynamodb.get(params).promise();
  return result.Item as AnomalyThreshold | null;
}

function calculateStatistics(data: number[]): AnomalyThreshold {
  if (data.length === 0) {
    return { mean: 0, stdDev: 0, samples: 0, lastUpdated: Date.now() };
  }
  
  const mean = data.reduce((sum, val) => sum + val, 0) / data.length;
  const variance = data.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / data.length;
  const stdDev = Math.sqrt(variance);
  
  return { 
    mean, 
    stdDev, 
    samples: data.length,
    lastUpdated: Date.now()
  };
}

function checkStatisticalAnomaly(
  currentCost: number, 
  stats: AnomalyThreshold
): { score: number; reason: string } {
  if (stats.samples < 7 || stats.stdDev === 0) {
    return { score: 0, reason: 'Insufficient data for statistical analysis' };
  }
  
  // Calculate z-score
  const zScore = Math.abs((currentCost - stats.mean) / stats.stdDev);
  
  // Convert z-score to anomaly score
  let score = 0;
  let reason = '';
  
  if (zScore >= 3) {
    score = 0.997;
    reason = `Cost is ${zScore.toFixed(1)} standard deviations from mean`;
  } else if (zScore >= 2.5) {
    score = 0.98;
    reason = `Cost is ${zScore.toFixed(1)} standard deviations from mean`;
  } else if (zScore >= 2) {
    score = 0.95;
    reason = `Cost is ${zScore.toFixed(1)} standard deviations from mean`;
  } else if (zScore >= 1.5) {
    score = 0.87;
    reason = `Cost is moderately unusual (${zScore.toFixed(1)} std devs)`;
  }
  
  return { score, reason };
}

function checkPercentageSpike(
  currentCost: number,
  historicalData: number[]
): { score: number; reason: string } {
  if (historicalData.length === 0) {
    return { score: 0, reason: 'No historical data for spike detection' };
  }
  
  const recentAverage = historicalData.slice(-7).reduce((a, b) => a + b, 0) / 
    Math.min(historicalData.length, 7);
  
  if (recentAverage === 0) {
    return { score: 0, reason: 'No recent costs to compare' };
  }
  
  const percentageIncrease = ((currentCost - recentAverage) / recentAverage) * 100;
  
  if (percentageIncrease > 300) {
    return { score: 0.99, reason: `${percentageIncrease.toFixed(0)}% spike from recent average` };
  } else if (percentageIncrease > 200) {
    return { score: 0.97, reason: `${percentageIncrease.toFixed(0)}% spike from recent average` };
  } else if (percentageIncrease > 100) {
    return { score: 0.95, reason: `${percentageIncrease.toFixed(0)}% spike from recent average` };
  } else if (percentageIncrease > 50) {
    return { score: 0.85, reason: `${percentageIncrease.toFixed(0)}% increase from recent average` };
  }
  
  return { score: 0, reason: 'Normal variation' };
}

function checkAbsoluteThreshold(
  currentCost: number,
  service: string
): { score: number; reason: string } {
  // Service-specific absolute thresholds
  const thresholds: Record<string, number> = {
    'AmazonEC2': 5000,
    'AmazonRDS': 3000,
    'AmazonS3': 1000,
    'AWSLambda': 500,
    'AmazonDynamoDB': 1000,
    'default': 2000
  };
  
  const threshold = thresholds[service] || thresholds.default;
  
  if (currentCost > threshold * 2) {
    return { score: 0.98, reason: `Cost exceeds 2x threshold ($${threshold})` };
  } else if (currentCost > threshold) {
    return { score: 0.90, reason: `Cost exceeds threshold ($${threshold})` };
  }
  
  return { score: 0, reason: 'Within absolute threshold' };
}

function checkWeeklyPattern(
  currentCost: number,
  timestamp: number,
  stats: AnomalyThreshold
): { score: number; reason: string } {
  const dayOfWeek = new Date(timestamp).getDay();
  
  // If we have weekly pattern data
  if (stats.weeklyPattern && stats.weeklyPattern.length === 7) {
    const expectedForDay = stats.weeklyPattern[dayOfWeek];
    const deviation = Math.abs(currentCost - expectedForDay) / expectedForDay;
    
    if (deviation > 2) {
      return { 
        score: 0.95, 
        reason: `Cost deviates ${(deviation * 100).toFixed(0)}% from typical ${getDayName(dayOfWeek)}` 
      };
    }
  }
  
  return { score: 0, reason: 'Matches weekly pattern' };
}

function getDayName(day: number): string {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return days[day];
}

async function handleAnomaly(
  costEvent: CostEvent,
  record: any,
  anomalyResult: AnomalyResult
): Promise<void> {
  const anomalyEvent = {
    Source: 'cost.controller',
    DetailType: 'Anomaly Detected',
    Detail: JSON.stringify({
      accountId: costEvent.accountId,
      accountName: costEvent.accountName,
      service: costEvent.service,
      region: record.region,
      timestamp: record.timestamp,
      actualCost: anomalyResult.actualCost,
      expectedCost: anomalyResult.expectedCost,
      deviation: anomalyResult.deviation,
      deviationPercentage: anomalyResult.deviationPercentage,
      anomalyScore: anomalyResult.score,
      reasons: anomalyResult.reasons,
      hourlyRate: anomalyResult.actualCost,
      projectedDailyCost: anomalyResult.actualCost * 24,
      projectedMonthlyCost: anomalyResult.actualCost * 24 * 30
    }),
    EventBusName: process.env.EVENT_BUS_NAME
  };
  
  await eventbridge.putEvents({ Entries: [anomalyEvent] }).promise();
  
  console.log('Anomaly detected and event emitted', {
    accountId: costEvent.accountId,
    service: costEvent.service,
    score: anomalyResult.score,
    reasons: anomalyResult.reasons
  });
}

async function updateCostRecord(
  accountId: string,
  service: string,
  timestamp: number,
  region: string,
  anomalyResult: AnomalyResult
): Promise<void> {
  const params = {
    TableName: process.env.COST_TABLE_NAME!,
    Key: {
      pk: `COST#${accountId}`,
      sk: `${timestamp}#${service}#${region}`
    },
    UpdateExpression: 'SET hasAnomaly = :hasAnomaly, anomalyScore = :score, anomalyReasons = :reasons',
    ExpressionAttributeValues: {
      ':hasAnomaly': anomalyResult.isAnomaly ? 'true' : 'false',
      ':score': anomalyResult.score,
      ':reasons': anomalyResult.reasons
    }
  };
  
  await dynamodb.update(params).promise();
}

async function updateThreshold(
  accountId: string,
  service: string,
  currentCost: number,
  timestamp: number
): Promise<void> {
  const hour = new Date(timestamp).getHours();
  const dayOfWeek = new Date(timestamp).getDay();
  
  // Get existing threshold
  const existing = await getThreshold(accountId, service, hour);
  
  let newThreshold: AnomalyThreshold;
  
  if (existing && existing.samples > 0) {
    // Update using exponential moving average
    const alpha = 0.1; // Learning rate
    const newMean = (1 - alpha) * existing.mean + alpha * currentCost;
    const newVariance = (1 - alpha) * Math.pow(existing.stdDev, 2) + 
      alpha * Math.pow(currentCost - newMean, 2);
    
    // Update weekly pattern
    const weeklyPattern = existing.weeklyPattern || new Array(7).fill(existing.mean);
    weeklyPattern[dayOfWeek] = (weeklyPattern[dayOfWeek] * 0.9) + (currentCost * 0.1);
    
    newThreshold = {
      mean: newMean,
      stdDev: Math.sqrt(newVariance),
      samples: existing.samples + 1,
      weeklyPattern,
      lastUpdated: Date.now()
    };
  } else {
    // Initialize new threshold
    newThreshold = {
      mean: currentCost,
      stdDev: currentCost * 0.3, // Start with 30% standard deviation
      samples: 1,
      weeklyPattern: new Array(7).fill(currentCost),
      lastUpdated: Date.now()
    };
  }
  
  const params = {
    TableName: process.env.THRESHOLDS_TABLE_NAME!,
    Item: {
      pk: `THRESHOLD#${accountId}`,
      sk: `${service}#${hour}`,
      accountId,
      service,
      hour,
      ...newThreshold,
      ttl: Math.floor(Date.now() / 1000) + (180 * 24 * 60 * 60) // 180 days retention
    }
  };
  
  await dynamodb.put(params).promise();
}

async function publishMetrics(accountId: string, service: string): Promise<void> {
  const params = {
    Namespace: 'CostController/Anomalies',
    MetricData: [
      {
        MetricName: 'AnomalyChecked',
        Dimensions: [
          { Name: 'AccountId', Value: accountId },
          { Name: 'Service', Value: service }
        ],
        Value: 1,
        Unit: 'Count',
        Timestamp: new Date()
      }
    ]
  };
  
  await cloudwatch.putMetricData(params).promise();
}
