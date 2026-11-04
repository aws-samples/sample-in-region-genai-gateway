import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53_targets from 'aws-cdk-lib/aws-route53-targets';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';

export interface DnsStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  /** e.g. 'genai-gw.internal' */
  zoneName: string;
  /** ALB for gateway.{zoneName} → Smart Router (preferred entry point) */
  smartRouterAlb: elbv2.IApplicationLoadBalancer;
  /** ALB for admin.{zoneName} → Admin Console */
  adminAlb?: elbv2.IApplicationLoadBalancer;
}

export class DnsStack extends cdk.Stack {
  /** e.g. 'https://gateway.genai-gw.internal' */
  public readonly gatewayUrl: string;

  constructor(scope: Construct, id: string, props: DnsStackProps) {
    super(scope, id, props);

    const zone = new route53.PrivateHostedZone(this, 'Zone', {
      zoneName: props.zoneName,
      vpc: props.vpc,
      comment: 'In-Region GenAI Gateway — private DNS for researcher PCs',
    });

    // gateway.genai-gw.internal → Smart Router ALB (port 443)
    new route53.ARecord(this, 'GatewayRecord', {
      zone,
      recordName: 'gateway',
      target: route53.RecordTarget.fromAlias(
        new route53_targets.LoadBalancerTarget(props.smartRouterAlb),
      ),
    });

    if (props.adminAlb) {
      new route53.ARecord(this, 'AdminRecord', {
        zone,
        recordName: 'admin',
        target: route53.RecordTarget.fromAlias(
          new route53_targets.LoadBalancerTarget(props.adminAlb),
        ),
      });
    }

    this.gatewayUrl = `https://gateway.${props.zoneName}`;

    new cdk.CfnOutput(this, 'GatewayUrl', {
      value: this.gatewayUrl,
      description: 'Set as ANTHROPIC_BASE_URL in Claude Code (routes via Smart Router)',
    });
    new cdk.CfnOutput(this, 'AdminUrl', {
      value: `https://admin.${props.zoneName}`,
      description: 'Admin Console (VPN 필요)',
    });
  }
}
