import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { AnalyticsStackProps } from '../interfaces';

export class AnalyticsStack extends cdk.Stack {
  public readonly anomalyDetector: lambda.Function;

  constructor(scope: Construct, id: string, props: AnalyticsStackProps) {
    super(scope, id, props);

    // Placeholder - will be implemented in Week 2
    this.anomalyDetector = new lambda.Function(this, 'AnomalyDetectorPlaceholder', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        exports.handler = async () => {
          console.log('Anomaly detector placeholder');
          return { statusCode: 200 };
        };
      `)
    });
  }
}
