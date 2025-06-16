import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cdk from 'aws-cdk-lib';

export interface DataPipelineStackProps extends cdk.StackProps {
  // Add custom props if needed
}

export interface AnalyticsStackProps extends cdk.StackProps {
  costTable: dynamodb.Table;
  eventBus: events.EventBus;
}

export interface ApiStackProps extends cdk.StackProps {
  costTable: dynamodb.Table;
  analyticsEngine: lambda.Function;
}
