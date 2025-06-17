import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as logs from 'aws-cdk-lib/aws-logs';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import { AnalyticsStackProps } from '../interfaces';
import * as path from 'path';

export class AnalyticsStack extends cdk.Stack {
  public readonly anomalyDetector: lambda.Function;
  public readonly anomalyTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: AnalyticsStackProps) {
    super(scope, id, props);

    // Anomaly thresholds table for storing baselines
    const thresholdsTable = new dynamodb.Table(this, 'AnomalyThresholds', {
      tableName: `${this.stackName}-thresholds`,
      partitionKey: { 
        name: 'pk', 
        type: dynamodb.AttributeType.STRING 
      },
      sortKey: { 
        name: 'sk', 
        type: dynamodb.AttributeType.STRING 
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: 'ttl'
    });

    // Add GSI for querying by service
    thresholdsTable.addGlobalSecondaryIndex({
      indexName: 'ServiceThresholds',
      partitionKey: { 
        name: 'service', 
        type: dynamodb.AttributeType.STRING 
      },
      sortKey: { 
        name: 'lastUpdated', 
        type: dynamodb.AttributeType.NUMBER 
      },
      projectionType: dynamodb.ProjectionType.ALL
    });

    // SNS topic for anomaly alerts
    this.anomalyTopic = new sns.Topic(this, 'AnomalyAlerts', {
      displayName: 'AWS Cost Anomaly Alerts',
      topicName: `${this.stackName}-anomaly-alerts`
    });

    // Add email subscription (you can add this after deployment)
    // For now, we'll add a placeholder
    new cdk.CfnOutput(this, 'AnomalyTopicArn', {
      value: this.anomalyTopic.topicArn,
      description: 'SNS Topic ARN for anomaly alerts - subscribe your email'
    });

    // Log group for anomaly detector
    const anomalyLogGroup = new logs.LogGroup(this, 'AnomalyDetectorLogs', {
      logGroupName: `/aws/lambda/${this.stackName}-anomaly-detector`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    // Anomaly detection Lambda
    this.anomalyDetector = new NodejsFunction(this, 'AnomalyDetector', {
      functionName: `${this.stackName}-anomaly-detector`,
      entry: path.join(__dirname, '../../../lambdas/anomaly-detector/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_18_X,
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      environment: {
        COST_TABLE_NAME: props.costTable.tableName,
        THRESHOLDS_TABLE_NAME: thresholdsTable.tableName,
        EVENT_BUS_NAME: props.eventBus.eventBusName,
        SNS_TOPIC_ARN: this.anomalyTopic.topicArn,
        LOG_LEVEL: 'INFO'
      },
      logGroup: anomalyLogGroup,
      bundling: {
        minify: false,
        sourceMap: true,
        sourcesContent: false,
        target: 'node18',
        externalModules: [],
        nodeModules: ['aws-sdk', 'luxon']
      },
      tracing: lambda.Tracing.ACTIVE,
      retryAttempts: 2
    });

    // Grant permissions
    props.costTable.grantReadWriteData(this.anomalyDetector);
    thresholdsTable.grantReadWriteData(this.anomalyDetector);
    props.eventBus.grantPutEventsTo(this.anomalyDetector);
    this.anomalyTopic.grantPublish(this.anomalyDetector);

    // Process cost events for anomalies
    new events.Rule(this, 'ProcessCostEvents', {
      ruleName: `${this.stackName}-process-cost-events`,
      eventBus: props.eventBus,
      eventPattern: {
        source: ['cost.controller'],
        detailType: ['Cost Data Collected']
      },
      targets: [new targets.LambdaFunction(this.anomalyDetector)]
    });

    // Alert sender Lambda
    const alertSender = new NodejsFunction(this, 'AlertSender', {
      functionName: `${this.stackName}-alert-sender`,
      entry: path.join(__dirname, '../../../lambdas/alert-sender/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_18_X,
      timeout: cdk.Duration.minutes(1),
      memorySize: 256,
      environment: {
        SNS_TOPIC_ARN: this.anomalyTopic.topicArn,
        COST_TABLE_NAME: props.costTable.tableName
      },
      bundling: {
        minify: false,
        sourceMap: true,
        target: 'node18',
        externalModules: [],
        nodeModules: ['aws-sdk']
      }
    });

    this.anomalyTopic.grantPublish(alertSender);
    props.costTable.grantReadData(alertSender);

    // Process anomaly events
    new events.Rule(this, 'ProcessAnomalies', {
      ruleName: `${this.stackName}-process-anomalies`,
      eventBus: props.eventBus,
      eventPattern: {
        source: ['cost.controller'],
        detailType: ['Anomaly Detected']
      },
      targets: [new targets.LambdaFunction(alertSender)]
    });

    // Pattern analyzer Lambda (runs daily)
    const patternAnalyzer = new NodejsFunction(this, 'PatternAnalyzer', {
      functionName: `${this.stackName}-pattern-analyzer`,
      entry: path.join(__dirname, '../../../lambdas/pattern-analyzer/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_18_X,
      timeout: cdk.Duration.minutes(10),
      memorySize: 1024,
      environment: {
        COST_TABLE_NAME: props.costTable.tableName,
        THRESHOLDS_TABLE_NAME: thresholdsTable.tableName
      },
      bundling: {
        minify: false,
        sourceMap: true,
        target: 'node18',
        externalModules: [],
        nodeModules: ['aws-sdk', 'luxon']
      }
    });

    props.costTable.grantReadData(patternAnalyzer);
    thresholdsTable.grantReadWriteData(patternAnalyzer);

    // Schedule pattern analysis daily at 3 AM UTC
    new events.Rule(this, 'DailyPatternAnalysis', {
      ruleName: `${this.stackName}-pattern-analysis`,
      schedule: events.Schedule.cron({ 
        minute: '0', 
        hour: '3' 
      }),
      targets: [new targets.LambdaFunction(patternAnalyzer)]
    });

    // CloudWatch Dashboard for anomaly monitoring
    const dashboard = new cdk.aws_cloudwatch.Dashboard(this, 'AnomalyDashboard', {
      dashboardName: `${this.stackName}-anomalies`
    });

    dashboard.addWidgets(
      new cdk.aws_cloudwatch.GraphWidget({
        title: 'Anomaly Detection Performance',
        left: [this.anomalyDetector.metricDuration()],
        right: [this.anomalyDetector.metricErrors()]
      }),
      new cdk.aws_cloudwatch.GraphWidget({
        title: 'Anomalies Detected',
        left: [this.anomalyDetector.metricInvocations()]
      })
    );

    // Outputs
    new cdk.CfnOutput(this, 'ThresholdsTableName', {
      value: thresholdsTable.tableName,
      description: 'DynamoDB table for anomaly thresholds'
    });

    new cdk.CfnOutput(this, 'AnomalyDetectorFunctionName', {
      value: this.anomalyDetector.functionName,
      description: 'Anomaly detector Lambda function'
    });
  }
}
