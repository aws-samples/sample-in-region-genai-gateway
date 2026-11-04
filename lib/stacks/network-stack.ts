import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

export interface NetworkStackProps extends cdk.StackProps {
  clusterName: string;
}

export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    this.vpc = new ec2.Vpc(this, 'GenAiGwVpc', {
      vpcName: `${props.clusterName}-vpc`,
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
      maxAzs: 3,
      natGateways: 1,
      subnetConfiguration: [
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 20,
        },
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
    });

    // EKS Auto Mode requires these tags for subnet discovery
    this.vpc.privateSubnets.forEach((subnet) => {
      cdk.Tags.of(subnet).add(`kubernetes.io/cluster/${props.clusterName}`, 'shared');
      cdk.Tags.of(subnet).add('kubernetes.io/role/internal-elb', '1');
    });

    this.vpc.publicSubnets.forEach((subnet) => {
      cdk.Tags.of(subnet).add(`kubernetes.io/cluster/${props.clusterName}`, 'shared');
      cdk.Tags.of(subnet).add('kubernetes.io/role/elb', '1');
    });

    // Custom Resource: delete EKS-owned SGs (eks-cluster-sg-*) on VPC destroy.
    // EKS auto-creates a cluster SG that is not owned by any CDK stack, so it
    // survives EksStack deletion and blocks VPC deletion.
    const sgCleanupRole = new iam.Role(this, 'SgCleanupRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
      inlinePolicies: {
        SgCleanup: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['ec2:DescribeSecurityGroups', 'ec2:DeleteSecurityGroup'],
              resources: ['*'],
            }),
          ],
        }),
      },
    });

    const sgCleanupFn = new lambda.Function(this, 'SgCleanupFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      role: sgCleanupRole,
      timeout: cdk.Duration.minutes(5),
      code: lambda.Code.fromInline(`
import boto3

def handler(event, context):
    if event.get('RequestType') != 'Delete':
        return
    vpc_id = event['ResourceProperties']['VpcId']
    cluster_name = event['ResourceProperties']['ClusterName']
    ec2 = boto3.client('ec2')
    sgs = ec2.describe_security_groups(
        Filters=[
            {'Name': 'vpc-id', 'Values': [vpc_id]},
            {'Name': 'tag:aws:eks:cluster-name', 'Values': [cluster_name]},
        ]
    )['SecurityGroups']
    for sg in sgs:
        try:
            ec2.delete_security_group(GroupId=sg['GroupId'])
            print(f"Deleted SG {sg['GroupId']} ({sg['GroupName']})")
        except Exception as e:
            print(f"Skipped {sg['GroupId']}: {e}")
`),
    });

    const sgCleanupProvider = new cr.Provider(this, 'SgCleanupProvider', {
      onEventHandler: sgCleanupFn,
    });

    const sgCleanup = new cdk.CustomResource(this, 'SgCleanup', {
      serviceToken: sgCleanupProvider.serviceToken,
      properties: {
        VpcId: this.vpc.vpcId,
        ClusterName: props.clusterName,
      },
    });
    // CustomResource must be deleted BEFORE the VPC, so it runs sg cleanup first
    sgCleanup.node.addDependency(this.vpc);

    // VPC Endpoints — data residency requires no internet egress for AWS service calls
    // Gateway endpoints (free, no per-hour charge)
    this.vpc.addGatewayEndpoint('S3GatewayEP', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    // Interface endpoints — 1 AZ only to avoid 3× per-hour charge (~$200/mo savings)
    // All ECS Fargate tasks and EKS nodes schedule into the same AZ as the endpoint.
    const vpcEpSG = new ec2.SecurityGroup(this, 'VpcEndpointSG', {
      vpc: this.vpc,
      description: 'Allow HTTPS from within VPC to interface endpoints',
      allowAllOutbound: false,
    });
    vpcEpSG.addIngressRule(ec2.Peer.ipv4(this.vpc.vpcCidrBlock), ec2.Port.tcp(443));

    const interfaceEndpoints: { id: string; service: ec2.InterfaceVpcEndpointAwsService }[] = [
      { id: 'BedrockRuntimeEP', service: ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME },
      { id: 'EcrApiEP', service: ec2.InterfaceVpcEndpointAwsService.ECR },
      { id: 'EcrDkrEP', service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER },
      { id: 'CloudWatchLogsEP', service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS },
      { id: 'KmsEP', service: ec2.InterfaceVpcEndpointAwsService.KMS },
      { id: 'SecretsManagerEP', service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER },
      // ECS Fargate endpoints — required for the SmartRouter / Admin Console ECS tasks (data residency: no internet egress)
      { id: 'EcsEP', service: ec2.InterfaceVpcEndpointAwsService.ECS },
      { id: 'EcsAgentEP', service: ec2.InterfaceVpcEndpointAwsService.ECS_AGENT },
      { id: 'EcsTelemetryEP', service: ec2.InterfaceVpcEndpointAwsService.ECS_TELEMETRY },
      // SSM endpoints — let the optional in-VPC test client (GenAiGwTestClientStack)
      // be reached via SSM Session Manager with NO public network path. The three
      // SSM interface endpoints are the documented minimum for Session Manager.
      { id: 'SsmEP', service: ec2.InterfaceVpcEndpointAwsService.SSM },
      { id: 'SsmMessagesEP', service: ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES },
      { id: 'Ec2MessagesEP', service: ec2.InterfaceVpcEndpointAwsService.EC2_MESSAGES },
    ];

    for (const ep of interfaceEndpoints) {
      new ec2.InterfaceVpcEndpoint(this, ep.id, {
        vpc: this.vpc,
        service: ep.service,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, availabilityZones: [this.vpc.availabilityZones[0]] },
        securityGroups: [vpcEpSG],
        privateDnsEnabled: true,
      });
    }

    new cdk.CfnOutput(this, 'VpcId', { value: this.vpc.vpcId });
  }
}
