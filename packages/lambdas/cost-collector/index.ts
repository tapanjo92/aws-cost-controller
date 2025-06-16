import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';
import { OrganizationsClient, DescribeOrganizationCommand, ListAccountsCommand } from '@aws-sdk/client-organizations';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { DateTime } from 'luxon';
import { Context, ScheduledEvent } from 'aws-lambda';

// Initialize AWS SDK v3 clients
const ceClient = new CostExplorerClient({ region: process.env.AWS_REGION });
const orgsClient = new OrganizationsClient({ region: process.env.AWS_REGION });
const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const eventbridgeClient = new EventBridgeClient({ region: process.env.AWS_REGION });
const stsClient = new STSClient({ region: process.env.AWS_REGION });

// Types
interface CostData {
  accountId: string;
  accountName: string;
  service: string;
  region: string;
  cost: number;
  usage: Record<string, number>;
  currency: string;
  timestamp: number;
  date: string;
  hour: number;
}

interface CollectionConfig {
  collectionType: 'hourly' | 'daily';
  lookbackHours?: number;
  lookbackDays?: number;
}

// Constants
const BATCH_SIZE = 25; // DynamoDB batch write limit
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // ms

// Main handler
export const handler = async (event: ScheduledEvent, context: Context): Promise<void> => {
  console.log('Cost collection started', { event, context });
  
  const startTime = Date.now();
  const config: CollectionConfig = event.detail || { collectionType: 'hourly', lookbackHours: 2 };
  
  try {
    // Step 1: Get all active accounts
    const accounts = await getAllAccounts();
    console.log(`Found ${accounts.length} active accounts`);
    
    // Step 2: Collect costs for each account
    const allCostData: CostData[] = [];
    
    // Process accounts in batches to avoid throttling
    const accountBatches = chunkArray(accounts, 5);
    
    for (const batch of accountBatches) {
      const batchPromises = batch.map(account => 
        collectAccountCosts(account.Id!, account.Name!, config)
          .catch(error => {
            console.error(`Failed to collect costs for account ${account.Id}:`, error);
            return [];
          })
      );
      
      const batchResults = await Promise.all(batchPromises);
      allCostData.push(...batchResults.flat());
    }
    
    console.log(`Collected ${allCostData.length} cost records`);
    
    // Step 3: Store cost data in DynamoDB
    if (allCostData.length > 0) {
      await storeCostData(allCostData);
    }
    
    // Step 4: Emit events for real-time processing
    await emitCostEvents(allCostData);
    
    const duration = Date.now() - startTime;
    console.log(`Cost collection completed in ${duration}ms`, {
      accountsProcessed: accounts.length,
      recordsStored: allCostData.length,
      duration
    });
    
  } catch (error) {
    console.error('Cost collection failed:', error);
    throw error;
  }
};

// Get all active accounts in the organization
async function getAllAccounts(): Promise<any[]> {
  const accounts: any[] = [];
  let nextToken: string | undefined;
  
  try {
    // First, check if we're in an organization
    const orgInfo = await orgsClient.send(new DescribeOrganizationCommand({}));
    console.log('Organization info:', orgInfo.Organization);
  } catch (error: any) {
    if (error.code === 'AWSOrganizationsNotInUseException') {
      // Not in an organization, return current account
      console.log('Not in an organization, using current account');
      const accountId = process.env.AWS_ACCOUNT_ID || await getCurrentAccountId();
      return [{
        Id: accountId,
        Name: 'Current Account',
        Status: 'ACTIVE',
        JoinedTimestamp: new Date()
      }];
    }
    throw error;
  }
  
  // List all accounts in the organization
  do {
    const response = await orgsClient.send(new ListAccountsCommand({ NextToken: nextToken }));
    accounts.push(...(response.Accounts || []));
    nextToken = response.NextToken;
  } while (nextToken);
  
  return accounts.filter(acc => acc.Status === 'ACTIVE');
}

// Get current account ID
async function getCurrentAccountId(): Promise<string> {
  const identity = await stsClient.send(new GetCallerIdentityCommand({}));
  return identity.Account!;
}

// Collect costs for a specific account
async function collectAccountCosts(
  accountId: string, 
  accountName: string,
  config: CollectionConfig
): Promise<CostData[]> {
  const now = DateTime.now();
  let start: string;
  let end: string;
  let granularity: 'HOURLY' | 'DAILY';
  
  if (config.collectionType === 'hourly') {
    const lookback = config.lookbackHours || 2;
    start = now.minus({ hours: lookback }).toFormat('yyyy-MM-dd\'T\'HH:\':00:00\'');
    end = now.toFormat('yyyy-MM-dd\'T\'HH:\':00:00\'');
    granularity = 'HOURLY';
  } else {
    const lookback = config.lookbackDays || 2;
    start = now.minus({ days: lookback }).toISODate()!;
    end = now.toISODate()!;
    granularity = 'DAILY';
  }
  
  console.log(`Collecting ${granularity} costs for account ${accountId} (${accountName}) from ${start} to ${end}`);
  
  const params = {
    TimePeriod: { Start: start, End: end },
    Granularity: granularity,
    Metrics: ['UnblendedCost', 'UsageQuantity'],
    GroupBy: [
      { Type: 'DIMENSION' as any, Key: 'SERVICE' },
      { Type: 'DIMENSION' as any, Key: 'REGION' },
      { Type: 'DIMENSION' as any, Key: 'USAGE_TYPE' }
    ],
    Filter: {
      Dimensions: {
        Key: 'LINKED_ACCOUNT' as any,
        Values: [accountId]
      }
    }
  };
  
  try {
    const result = await retryWithBackoff(() => ceClient.send(new GetCostAndUsageCommand(params)));
    
    const costData: CostData[] = [];
    
    result.ResultsByTime?.forEach(timeResult => {
      const timestamp = new Date(timeResult.TimePeriod?.Start || '').getTime();
      const dateTime = DateTime.fromMillis(timestamp);
      
      timeResult.Groups?.forEach(group => {
        const service = group.Keys?.[0] || 'Unknown';
        const region = group.Keys?.[1] || 'Unknown';
        const usageType = group.Keys?.[2] || 'Unknown';
        
        // Skip if cost is 0
        const cost = parseFloat(group.Metrics?.UnblendedCost?.Amount || '0');
        if (cost === 0) return;
        
        costData.push({
          accountId,
          accountName,
          service,
          region,
          cost,
          usage: { 
            [usageType]: parseFloat(group.Metrics?.UsageQuantity?.Amount || '0') 
          },
          currency: group.Metrics?.UnblendedCost?.Unit || 'USD',
          timestamp,
          date: dateTime.toISODate()!,
          hour: dateTime.hour
        });
      });
    });
    
    return costData;
    
  } catch (error) {
    console.error(`Failed to get costs for account ${accountId}:`, error);
    throw error;
  }
}

// Retry function with exponential backoff
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  retries: number = MAX_RETRIES,
  delay: number = RETRY_DELAY
): Promise<T> {
  try {
    return await fn();
  } catch (error: any) {
    if (retries === 0) throw error;
    
    // Check if error is retryable
    if (error.code === 'ThrottlingException' || error.code === 'RequestLimitExceeded') {
      console.log(`Throttled, retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return retryWithBackoff(fn, retries - 1, delay * 2);
    }
    
    throw error;
  }
}

// Store cost data in DynamoDB
async function storeCostData(costData: CostData[]): Promise<void> {
  const chunks = chunkArray(costData, BATCH_SIZE);
  
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    
    const params = {
      RequestItems: {
        [process.env.COST_TABLE_NAME!]: chunk.map(item => ({
          PutRequest: {
            Item: {
              pk: `COST#${item.accountId}`,
              sk: `${item.timestamp}#${item.service}#${item.region}`,
              accountId: item.accountId,
              accountName: item.accountName,
              service: item.service,
              region: item.region,
              cost: item.cost,
              usage: item.usage,
              currency: item.currency,
              timestamp: item.timestamp,
              date: item.date,
              hour: item.hour,
              hasAnomaly: 'false', // Default, will be updated by anomaly detector
              anomalyScore: 0,
              ttl: Math.floor(Date.now() / 1000) + (90 * 24 * 60 * 60) // 90 days retention
            }
          }
        }))
      }
    };
    
    try {
      await retryWithBackoff(() => docClient.send(new BatchWriteCommand(params)));
      console.log(`Stored batch ${i + 1}/${chunks.length} (${chunk.length} items)`);
    } catch (error) {
      console.error(`Failed to store batch ${i + 1}:`, error);
      throw error;
    }
  }
}

// Emit events for real-time processing
async function emitCostEvents(costData: CostData[]): Promise<void> {
  if (costData.length === 0) return;
  
  // Group events by service for aggregated notifications
  const serviceGroups = costData.reduce((acc, cost) => {
    const key = `${cost.accountId}#${cost.service}`;
    if (!acc[key]) {
      acc[key] = {
        accountId: cost.accountId,
        accountName: cost.accountName,
        service: cost.service,
        totalCost: 0,
        records: []
      };
    }
    acc[key].totalCost += cost.cost;
    acc[key].records.push(cost);
    return acc;
  }, {} as Record<string, any>);
  
  const events = Object.values(serviceGroups).map(group => ({
    Source: 'cost.controller',
    DetailType: 'Cost Data Collected',
    Detail: JSON.stringify(group),
    EventBusName: process.env.EVENT_BUS_NAME
  }));
  
  // EventBridge has a limit of 10 events per request
  const eventChunks = chunkArray(events, 10);
  
  for (const chunk of eventChunks) {
    try {
      await eventbridgeClient.send(new PutEventsCommand({ Entries: chunk }));
    } catch (error) {
      console.error('Failed to emit events:', error);
      // Don't throw here - events are nice to have but not critical
    }
  }
  
  console.log(`Emitted ${events.length} cost events`);
}

// Utility function to chunk arrays
function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}
