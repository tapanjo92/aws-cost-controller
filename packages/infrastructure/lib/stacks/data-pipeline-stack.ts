import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import * as path from 'path';

export class DataPipelineStack extends cdk.Stack {
  public readonly costTable: dynamodb.Table;
  public readonly eventBus: events.EventBus;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create DynamoDB table with optimized partition key design
    this.costTable = new dynamodb.Table(this, 'CostData', {
      tableName: `${this.stackName}-costs`,
      partitionKey: { 
        name: 'pk', 
        type: dynamodb.AttributeType.STRING 
      },
      sortKey: { 
        name: 'sk', 
        type: dynamodb.AttributeType.STRING 
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      pointInTimeRecovery: true,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
    });

    // Add GSI for time-series queries
    this.costTable.addGlobalSecondaryIndex({
      indexName: 'TimeSeries',
      partitionKey: { 
        name: 'accountId', 
        type: dynamodb.AttributeType.STRING 
      },
      sortKey: { 
        name: 'timestamp', 
        type: dynamodb.AttributeType.NUMBER 
      },
      projectionType: dynamodb.ProjectionType.ALL
    });

    // Add GSI for service-based queries
    this.costTable.addGlobalSecondaryIndex({
      indexName: 'ServiceCosts',
      partitionKey: { 
        name: 'service', 
        type: dynamodb.AttributeType.STRING 
      },
      sortKey: { 
        name: 'timestamp', 
        type: dynamodb.AttributeType.NUMBER 
      },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: ['cost', 'usage', 'accountId', 'region']
    });

    // Add GSI for anomaly queries
    this.costTable.addGlobalSecondaryIndex({
      indexName: 'AnomalyCosts',
      partitionKey: { 
        name: 'hasAnomaly', 
        type: dynamodb.AttributeType.STRING 
      },
      sortKey: { 
        name: 'anomalyScore', 
        type: dynamodb.AttributeType.NUMBER 
      },
      projectionType: dynamodb.ProjectionType.ALL
    });

    // Create EventBridge event bus
    this.eventBus = new events.EventBus(this, 'CostEvents', {
      eventBusName: `${this.stackName}-events`
    });

    // Create log group for Lambda functions
    const logGroup = new logs.LogGroup(this, 'CostCollectorLogs', {
      logGroupName: `/aws/lambda/${this.stackName}-cost-collector`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    // Cost collector Lambda with proper bundling
    const costCollector = new NodejsFunction(this, 'CostCollector', {
      functionName: `${this.stackName}-cost-collector`,
      entry: path.join(__dirname, '../../../lambdas/cost-collector/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_18_X,
      timeout: cdk.Duration.minutes(15),
      memorySize: 1024,
      environment: {
        COST_TABLE_NAME: this.costTable.tableName,
        EVENT_BUS_NAME: this.eventBus.eventBusName,
        LOG_LEVEL: 'INFO'
      },
      logGroup,
      bundling: {
        minify: true,
        sourceMap: true,
        sourcesContent: false,
        target: 'node18',
        externalModules: ['aws-sdk']
      },
      tracing: lambda.Tracing.ACTIVE,
      retryAttempts: 2
    });

    // Grant permissions
    this.costTable.grantReadWriteData(costCollector);
    this.eventBus.grantPutEventsTo(costCollector);

    // IAM role for Cost Explorer and Organizations access
    costCollector.addToRolePolicy(new iam.PolicyStatement({
      sid: 'CostExplorerAccess',
      effect: iam.Effect.ALLOW,
      actions: [
        'ce:GetCostAndUsage',
        'ce:GetCostAndUsageWithResources',
        'ce:GetCostForecast',
        'ce:GetDimensionValues',
        'ce:GetReservationUtilization',
        'ce:GetSavingsPlanUtilization'
      ],
      resources: ['*']
    }));

    costCollector.addToRolePolicy(new iam.PolicyStatement({
      sid: 'OrganizationsAccess',
      effect: iam.Effect.ALLOW,
      actions: [
        'organizations:ListAccounts',
        'organizations:DescribeOrganization',
        'organizations:DescribeAccount'
      ],
      resources: ['*']
    }));

    // Schedule cost collection
    // Every hour for real-time monitoring
    new events.Rule(this, 'HourlyCostCollection', {
      ruleName: `${this.stackName}-hourly-collection`,
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
      targets: [new targets.LambdaFunction(costCollector, {
        event: events.RuleTargetInput.fromObject({
          source: 'scheduled',
          detail: {
            collectionType: 'hourly',
            lookbackHours: 2
          }
        })
      })]
    });

    // Daily detailed collection at 2 AM UTC
    new events.Rule(this, 'DailyCostCollection', {
      ruleName: `${this.stackName}-daily-collection`,
      schedule: events.Schedule.cron({ 
        minute: '0', 
        hour: '2' 
      }),
      targets: [new targets.LambdaFunction(costCollector, {
        event: events.RuleTargetInput.fromObject({
          source: 'scheduled',
          detail: {
            collectionType: 'daily',
            lookbackDays: 2
          }
        })
      })]
    });

    // CloudWatch Dashboard for monitoring
    const dashboard = new cdk.aws_cloudwatch.Dashboard(this, 'CostCollectorDashboard', {
      dashboardName: `${this.stackName}-pipeline`
    });

    // Add Lambda metrics
    dashboard.addWidgets(
      new cdk.aws_cloudwatch.GraphWidget({
        title: 'Cost Collector Performance',
        left: [costCollector.metricDuration()],
        right: [costCollector.metricErrors()]
      })
    );

    // Outputs
    new cdk.CfnOutput(this, 'CostTableName', {
      value: this.costTable.tableName,
      description: 'DynamoDB table for cost data'
    });

    new cdk.CfnOutput(this, 'EventBusName', {
      value: this.eventBus.eventBusName,
      description: 'EventBridge bus for cost events'
    });

    new cdk.CfnOutput(this, 'CostCollectorFunctionName', {
      value: costCollector.functionName,
      description: 'Cost collector Lambda function'
    });
  }
}
