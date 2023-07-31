import { Logger } from '@aws-lambda-powertools/logger';
import { AthenaClient, GetQueryExecutionCommand, GetQueryExecutionCommandOutput, QueryExecutionState, StartQueryExecutionCommand, StartQueryExecutionCommandInput } from '@aws-sdk/client-athena';
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';

const logger = new Logger({
  serviceName: 'GenerateReportCSV',
});
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export const onEvent = async (
  event?: any,
  //@ts-ignore
  context: Context,
  //@ts-ignore
  callback: Callback,
): Promise<boolean> => {
  logger.info(`Event: ${JSON.stringify(event)}`);
  const today = new Date();
  const yesterday = new Date(today.setDate(today.getDate() - 1));
  const yesterdayString=yesterday.toISOString().substring(0, 10);
  const createTable = `CREATE TABLE \"${process.env.DATABASE}\".\"tag_inventory_csv\"\n` +
		'WITH (\n' +
		"      format = 'TEXTFILE',\n" +
		"      field_delimiter = ',',\n" +
		`      external_location = 's3://${process.env.REPORT_BUCKET}/${yesterdayString}',\n` +
		"      bucketed_by = ARRAY['d'],\n" +
		'      bucket_count = 1)\n' +
		`AS (\n SELECT d,tagname,tagvalue,r.owningAccountId,r.region,r.service,r.resourceType,r.arn FROM \"${process.env.DATABASE}\".\"${process.env.TAG_INVENTORY_TABLE}\", unnest(\"resources\") as t (\"r\") where d='${yesterdayString}'\n);`;
  const client = new AthenaClient({});
  const input: StartQueryExecutionCommandInput = { // StartQueryExecutionInput
    QueryString: createTable, // required
    WorkGroup: process.env.WORKGROUP,
  };
  try {
    logger.info('Creating table');
    const startQueryExecutionResponse = await client.send(new StartQueryExecutionCommand(input));
    let response: GetQueryExecutionCommandOutput | undefined = undefined;
    while (response == undefined || ['RUNNING', 'QUEUED'].includes(response.QueryExecution?.Status?.State!)) {
      // @ts-ignore
      response = await client.send(new GetQueryExecutionCommand({
        QueryExecutionId: startQueryExecutionResponse?.QueryExecutionId,
      }));
      logger.info(`Status: ${response.QueryExecution?.Status?.State}`);
      await sleep(3000);

    }

    if (QueryExecutionState.SUCCEEDED == response.QueryExecution?.Status?.State) {
      logger.info(`Create table succeeeded: ${JSON.stringify(response)}`);
      const manifestUri = new URL(response.QueryExecution.Statistics?.DataManifestLocation!);
      const manifestBucket = manifestUri.hostname;
      const manifestKey = manifestUri.pathname.substring(1);
      const s3Client = new S3Client({});
      const getObjectResponse = await s3Client.send(new GetObjectCommand({
        Bucket: manifestBucket,
        Key: manifestKey,
      }));
      const dataFileLocation = await getObjectResponse.Body?.transformToString();
      const dataFileUri = new URL(dataFileLocation!);
      const dataFileBucket = dataFileUri.hostname;
      const dataFileKey = dataFileUri.pathname.substring(1);
      logger.info(`DataFileLocation: ${dataFileLocation}`);
      await s3Client.send(new CopyObjectCommand({
        CopySource: `${dataFileBucket}/${dataFileKey}`,
        Key: `tag-inventory-${yesterdayString}.csv.gz`,
        Bucket: process.env.REPORT_BUCKET,
      }));

      logger.info('Dropping table');
      await client.send(new StartQueryExecutionCommand({
        QueryString: `drop table \`${process.env.DATABASE}\`.\`tag_inventory_csv\``,
        WorkGroup: process.env.WORKGROUP,
      }));
      await s3Client.send(new DeleteObjectCommand({
        Bucket: dataFileBucket,
        Key: dataFileKey,

      }));
      await s3Client.send(new DeleteObjectCommand({
        Bucket: manifestBucket,
        Key: 'tables',

      }));
    } else {
      logger.error(`Create table failed: ${JSON.stringify(response.QueryExecution?.Status?.AthenaError)}`);
      return false;
    }
  } catch (e) {
    const error = e as Error;
    logger.error(`Error: ${JSON.stringify(error)}`);
    return false;
  }
  return true;


};