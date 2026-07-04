import {
  trackerRunPart1RxJsonSchema,
  trackerRunPart2RxJsonSchema,
  type TrackerRunPartRxJsonSchema,
} from '@tmrxjd/platform/tools';

/** Discord snowflake partition key for multi-user bot RxDB storage. */
export const BOT_RUN_RXDB_SCOPE_USER_ID_FIELD = 'botScopeUserId';

function withBotScopePartition(schema: TrackerRunPartRxJsonSchema): TrackerRunPartRxJsonSchema {
  return {
    ...schema,
    version: 0,
    properties: {
      ...schema.properties,
      [BOT_RUN_RXDB_SCOPE_USER_ID_FIELD]: {
        type: 'string',
        maxLength: 128,
      },
    },
    required: [...schema.required, BOT_RUN_RXDB_SCOPE_USER_ID_FIELD],
    indexes: [BOT_RUN_RXDB_SCOPE_USER_ID_FIELD],
  } as TrackerRunPartRxJsonSchema;
}

export const botRunPart1RxJsonSchema = withBotScopePartition(trackerRunPart1RxJsonSchema);
export const botRunPart2RxJsonSchema = withBotScopePartition(trackerRunPart2RxJsonSchema);
