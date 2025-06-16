#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { DataPipelineStack } from '../lib/stacks/data-pipeline-stack';
import { AnalyticsStack } from '../lib/stacks/analytics-stack';
import { ApiStack } from '../lib/stacks/api-stack';

const app = new cdk.App();

// Environment configuration
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'us-east-1'
};

// Deploy stacks with explicit dependencies
const dataPipeline = new DataPipelineStack(app, 'CostControllerData', { 
  env,
  description: 'Cost Controller Data Pipeline - Collects and stores AWS cost data'
});

const analytics = new AnalyticsStack(app, 'CostControllerAnalytics', { 
  env,
  costTable: dataPipeline.costTable,
  eventBus: dataPipeline.eventBus,
  description: 'Cost Controller Analytics - Anomaly detection and analysis'
});

const api = new ApiStack(app, 'CostControllerAPI', {
  env,
  costTable: dataPipeline.costTable,
  analyticsEngine: analytics.anomalyDetector,
  description: 'Cost Controller API - REST endpoints and authentication'
});

// Add tags to all stacks
cdk.Tags.of(app).add('Project', 'CostController');
cdk.Tags.of(app).add('Environment', 'Production');
cdk.Tags.of(app).add('ManagedBy', 'CDK');

app.synth();
