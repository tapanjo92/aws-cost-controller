import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ApiStackProps } from '../interfaces';

export class ApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    // Placeholder - will be implemented in Week 4
    new cdk.CfnOutput(this, 'ApiPlaceholder', {
      value: 'API will be implemented in Week 4',
      description: 'Placeholder for API implementation'
    });
  }
}
