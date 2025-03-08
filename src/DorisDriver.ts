/**
 * @copyright Cube Dev, Inc.
 * @license Apache-2.0
 * @fileoverview The `DorisDriver` and related types declaration.
 */

import {
  getEnv,
  assertDataSource,
} from '@cubejs-backend/shared';
import mysql, { Connection, ConnectionConfig, FieldInfo, QueryOptions } from 'mysql';
import genericPool from 'generic-pool';
import { promisify } from 'util';
import {
  BaseDriver,
  GenericDataBaseType,
  DriverInterface,
  StreamOptions,
  DownloadQueryResultsOptions,
  TableStructure,
  DownloadTableData,
  IndexesSQL,
  DownloadTableMemoryData,
  DriverCapabilities,
} from '@cubejs-backend/base-driver';
import { DorisQuery } from './DorisQuery';

const GenericTypeToDoris: Record<GenericDataBaseType, string> = {
  string: 'varchar(255)',
  text: 'string',
  decimal: 'decimal(38,10)',
};

/**
 * MySQL Native types -> Doris SQL type
 */
const MySqlNativeToDorisType = {
  [mysql.Types.DECIMAL]: 'decimal',
  [mysql.Types.NEWDECIMAL]: 'decimal',
  [mysql.Types.TINY]: 'tinyint',
  [mysql.Types.SHORT]: 'smallint',
  [mysql.Types.LONG]: 'int',
  [mysql.Types.INT24]: 'int',
  [mysql.Types.LONGLONG]: 'bigint',
  [mysql.Types.NEWDATE]: 'datetime',
  [mysql.Types.TIMESTAMP2]: 'datetime',
  [mysql.Types.DATETIME2]: 'datetime',
  [mysql.Types.TIME2]: 'time',
  [mysql.Types.TINY_BLOB]: 'string',
  [mysql.Types.MEDIUM_BLOB]: 'string',
  [mysql.Types.LONG_BLOB]: 'string',
  [mysql.Types.BLOB]: 'string',
  [mysql.Types.VAR_STRING]: 'varchar',
  [mysql.Types.STRING]: 'varchar',
};

const DorisToGenericType: Record<string, GenericDataBaseType> = {
  string: 'text',
  mediumint: 'int',
  smallint: 'int',
  bigint: 'int',
  tinyint: 'int',
  'mediumint unsigned': 'int',
  'smallint unsigned': 'int',
  'bigint unsigned': 'int',
  'tinyint unsigned': 'int',
};

export interface DorisDriverConfiguration extends ConnectionConfig {
  readOnly?: boolean,
  loadPreAggregationWithoutMetaLock?: boolean,
  storeTimezone?: string,
  pool?: any,
}

interface DorisConnection extends Connection {
  execute: (options: string | QueryOptions, values?: any) => Promise<any>
}

/**
 * Doris driver class.
 */
export class DorisDriver extends BaseDriver implements DriverInterface {
  /**
   * Returns default concurrency value.
   */
  public static getDefaultConcurrency(): number {
    return 2;
  }

  protected readonly config: DorisDriverConfiguration;

  protected readonly pool: genericPool.Pool<DorisConnection>;

  /**
   * Class constructor.
   */
  public constructor(
    config: DorisDriverConfiguration & {
      /**
       * Data source name.
       */
      dataSource?: string,

      /**
       * Max pool size value for the [cube]<-->[db] pool.
       */
      maxPoolSize?: number,

      /**
       * Time to wait for a response from a connection after validation
       * request before determining it as not valid. Default - 10000 ms.
       */
      testConnectionTimeout?: number,
    } = {}
  ) {
    super({
      testConnectionTimeout: config.testConnectionTimeout,
    });

    const dataSource =
      config.dataSource ||
      assertDataSource('default');

    const { pool, ...restConfig } = config;
    this.config = {
      host: getEnv('dbHost', { dataSource }),
      database: getEnv('dbName', { dataSource }),
      port: getEnv('dbPort', { dataSource }),
      user: getEnv('dbUser', { dataSource }),
      password: getEnv('dbPass', { dataSource }),
      socketPath: getEnv('dbSocketPath', { dataSource }),
      timezone: 'Z',
      ssl: this.getSslOptions(dataSource),
      dateStrings: true,
      readOnly: true,
      ...restConfig,
    };
    this.pool = genericPool.createPool({
      create: async () => {
        const conn: any = mysql.createConnection(this.config);
        const connect = promisify(conn.connect.bind(conn));

        if (conn.on) {
          conn.on('error', () => {
            conn.destroy();
          });
        }
        conn.execute = promisify(conn.query.bind(conn));

        await connect();

        return conn;
      },
      validate: async (connection) => {
        try {
          await connection.execute('SELECT 1');
        } catch (e) {
          this.databasePoolError(e);
          return false;
        }
        return true;
      },
      destroy: (connection) => promisify(connection.end.bind(connection))(),
    }, {
      min: 0,
      max:
        config.maxPoolSize ||
        getEnv('dbMaxPoolSize', { dataSource }) ||
        8,
      evictionRunIntervalMillis: 10000,
      softIdleTimeoutMillis: 30000,
      idleTimeoutMillis: 30000,
      testOnBorrow: true,
      acquireTimeoutMillis: 20000,
      ...pool
    });
  }

  public readOnly() {
    return !!this.config.readOnly;
  }

  protected withConnection(fn: (conn: DorisConnection) => Promise<any>) {
    const self = this;
    const connectionPromise = this.pool.acquire();

    let cancelled = false;
    const cancelObj: any = {};

    const promise: any = connectionPromise.then(async conn => {
      const [{ connectionId }] = await conn.execute('select connection_id() as connectionId');
      cancelObj.cancel = async () => {
        cancelled = true;
        await self.withConnection(async processConnection => {
          await processConnection.execute(`KILL ${connectionId}`);
        });
      };
      return fn(conn)
        .then(res => this.pool.release(conn).then(() => {
          if (cancelled) {
            throw new Error('Query cancelled');
          }
          return res;
        }))
        .catch((err) => this.pool.release(conn).then(() => {
          if (cancelled) {
            throw new Error('Query cancelled');
          }
          throw err;
        }));
    });
    promise.cancel = () => cancelObj.cancel();
    return promise;
  }

  public async testConnection() {
    // eslint-disable-next-line no-underscore-dangle
    const conn: DorisConnection = await (<any> this.pool)._factory.create();

    try {
      return await conn.execute('SELECT 1');
    } finally {
      // eslint-disable-next-line no-underscore-dangle
      await (<any> this.pool)._factory.destroy(conn);
    }
  }

  public async query(query: string, values: unknown[]) {
    return this.withConnection(async (conn) => {
      await this.setTimeZone(conn);
      return conn.execute(query, values);
    });
  }

  protected setTimeZone(conn: DorisConnection) {
    return conn.execute(`SET time_zone = '${this.config.storeTimezone || '+00:00'}'`, []);
  }

  public async release() {
    await this.pool.drain();
    await this.pool.clear();
  }

  public informationSchemaQuery() {
    return `${super.informationSchemaQuery()} AND columns.table_schema = '${this.config.database}'`;
  }

  public quoteIdentifier(identifier: string) {
    return `\`${identifier}\``;
  }

  public fromGenericType(columnType: GenericDataBaseType) {
    return GenericTypeToDoris[columnType] || super.fromGenericType(columnType);
  }

  public async stream(query: string, values: unknown[], { highWaterMark }: StreamOptions) {
    // eslint-disable-next-line no-underscore-dangle
    const conn: DorisConnection = await (<any> this.pool)._factory.create();

    try {
      await this.setTimeZone(conn);

      const [rowStream, fields] = await (
        new Promise<[any, mysql.FieldInfo[]]>((resolve, reject) => {
          const stream = conn.query(query, values).stream({ highWaterMark });

          stream.on('fields', (f) => {
            resolve([stream, f]);
          });
          stream.on('error', (e) => {
            reject(e);
          });
        })
      );

      return {
        rowStream,
        types: this.mapFieldsToGenericTypes(fields),
        release: async () => {
          // eslint-disable-next-line no-underscore-dangle
          await (<any> this.pool)._factory.destroy(conn);
        }
      };
    } catch (e) {
      // eslint-disable-next-line no-underscore-dangle
      await (<any> this.pool)._factory.destroy(conn);

      throw e;
    }
  }

  protected mapFieldsToGenericTypes(fields: mysql.FieldInfo[]) {
    return fields.map((field) => {
      // @ts-ignore
      let dbType = mysql.Types[field.type];

      if (field.type in MySqlNativeToDorisType) {
        // @ts-ignore
        dbType = MySqlNativeToDorisType[field.type];
      }

      return {
        name: field.name,
        type: this.toGenericType(dbType)
      };
    });
  }

  public async downloadQueryResults(query: string, values: unknown[], options: DownloadQueryResultsOptions) {
    if ((options || {}).streamImport) {
      return this.stream(query, values, options);
    }

    return this.withConnection(async (conn) => {
      await this.setTimeZone(conn);

      return new Promise((resolve, reject) => {
        conn.query(query, values, (err, rows, fields) => {
          if (err) {
            reject(err);
          } else {
            resolve({
              rows,
              types: this.mapFieldsToGenericTypes(<FieldInfo[]>fields),
            });
          }
        });
      });
    });
  }

  public toColumnValue(value: any, genericType: GenericDataBaseType) {
    if (genericType === 'timestamp' && typeof value === 'string') {
      return value && value.replace('Z', '');
    }
    if (genericType === 'boolean' && typeof value === 'string') {
      if (value.toLowerCase() === 'true') {
        return true;
      }
      if (value.toLowerCase() === 'false') {
        return false;
      }
    }
    return super.toColumnValue(value, genericType);
  }

  protected isDownloadTableDataRow(tableData: DownloadTableData): tableData is DownloadTableMemoryData {
    return (<DownloadTableMemoryData> tableData).rows !== undefined;
  }

  public async uploadTableWithIndexes(
    table: string,
    columns: TableStructure,
    tableData: DownloadTableData,
    indexesSql: IndexesSQL
  ) {
    if (!this.isDownloadTableDataRow(tableData)) {
      throw new Error(`${this.constructor} driver supports only rows upload`);
    }

    await this.createTable(table, columns);

    try {
      const batchSize = 1000; // TODO make dynamic?
      for (let j = 0; j < Math.ceil(tableData.rows.length / batchSize); j++) {
        const currentBatchSize = Math.min(tableData.rows.length - j * batchSize, batchSize);
        const indexArray = Array.from({ length: currentBatchSize }, (v, i) => i);
        const valueParamPlaceholders =
          indexArray.map(i => `(${columns.map((c, paramIndex) => this.param(paramIndex + i * columns.length)).join(', ')})`).join(', ');
        const params = indexArray.map(i => columns
          .map(c => this.toColumnValue(tableData.rows[i + j * batchSize][c.name], c.type)))
          .reduce((a, b) => a.concat(b), []);

        await this.query(
          `INSERT INTO ${table}
        (${columns.map(c => this.quoteIdentifier(c.name)).join(', ')})
        VALUES ${valueParamPlaceholders}`,
          params
        );
      }

      for (let i = 0; i < indexesSql.length; i++) {
        const [query, p] = indexesSql[i].sql;
        await this.query(query, p);
      }
    } catch (e) {
      await this.dropTable(table);
      throw e;
    }
  }

  public toGenericType(columnType: string) {
    return DorisToGenericType[columnType.toLowerCase()] ||
      DorisToGenericType[columnType.toLowerCase().split('(')[0]] ||
      super.toGenericType(columnType);
  }

  public capabilities(): DriverCapabilities {
    return {
      incrementalSchemaLoading: true,
    };
  }

  public static dialectClass() {
    return DorisQuery;
  }
} 