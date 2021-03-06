const pg = require('pg');
const co = require('co');
const QueryStream = require('pg-query-stream');
const is = require('is_js');
const R = require('ramda');
const CRC32 = require('crc-32');
const cRu = require('@panosoft/co-ramda-utils');

const _private = {
	logger: null,
	queryStreamOptions: {
		highWaterMark: 16 * 1024,
		batchSize: 10000
	},
	connectTimeout: 15000
};

const logError = (err, message) => {
	if (_private.logger) {
		message = message || '';
		_private.logger.error({err: err}, message);
	}
};

const logInfo = message => {
	if (_private.logger) {
		_private.logger.info(message);
	}
};

const getHostAndDb = connectionUrl => {
	// host is in first capturing group and database is in second capturing group
	const hostAndDb	= /@([\w\d.]+)\/([\w\d]+)/.exec(connectionUrl);
	if (hostAndDb && hostAndDb.length === 3) {
		return {host: hostAndDb[1], database: hostAndDb[2]};
	}
	else {
		return {host: 'n/a', database: 'n/a'};
	}
};

const createLockValue = s => { return {high: CRC32.str(s), low: CRC32.str(R.reverse(s))}; };

const setConnectTimeout = (reject, errorMessage, timerState) =>
	setTimeout(() => {
		timerState.expired = true;
		reject(errorMessage);
	}, _private.connectTimeout);

const dbUtils = {
	setDefaultOptions:  options => {
		if (options) {
			_private.logger = options.logger;
			if (options.highWaterMark && is.integer(options.highWaterMark) && is.positive(options.highWaterMark)) {
				_private.queryStreamOptions.highWaterMark = options.highWaterMark;
			}
			if (options.batchSize && is.integer(options.batchSize) && is.positive(options.batchSize)) {
				_private.queryStreamOptions.batchSize = options.batchSize;
			}
			if (options.connectTimeout && is.integer(options.connectTimeout) && is.positive(options.connectTimeout)) {
				_private.connectTimeout = options.connectTimeout;
			}
		}
	},
	createConnectionUrl: connectionParams => {
		const scheme = 'postgres';
		if (connectionParams.user) {
			if (connectionParams.password) {
				return `${scheme}://${connectionParams.user}:${connectionParams.password}@${connectionParams.host}/${connectionParams.databaseName}`;
			}
			else {
				return `${scheme}://${connectionParams.user}@${connectionParams.host}/${connectionParams.databaseName}`;
			}
		}
		else {
			return `${scheme}://${connectionParams.host}/${connectionParams.databaseName}`;
		}
	},
	createClient: conString => {
		var client = new pg.Client(conString);
		// wrap asynchronous callback in promise
		return new Promise((resolve, reject) => {
			const hostAndDb = getHostAndDb(conString);
			const timerState = {};
			const timer = setConnectTimeout(reject,
				new Error(`connect to database "${hostAndDb.database}" on host "${hostAndDb.host}" failed.  Error:  Connect timeout after ${_private.connectTimeout} millisec`),
				timerState);
			client.connect(err => {
				// need to handle errors in callback function since called asynchronously
				try {
					clearTimeout(timer);
					if (err) {
						logError(err, `connect to database "${hostAndDb.database}" on host "${hostAndDb.host}" failed.`);
						reject(err);
					}
					else {
						// timer has expired so Promise has already been rejected.  close returned client since it will never be used.
						if (timerState.expired) {
							logInfo(`closing connection to database "${hostAndDb.database}" on host "${hostAndDb.host}" that was returned after connection timeout`);
							dbUtils.close(client);
						}
						// timer has not expired so return client.
						else {
							resolve(client);
						}
					}
				}
				catch(err) {
					reject(err);
				}
			});
		});
	},
	createPooledClient: conString => {
		return new Promise((resolve, reject) => {
			const hostAndDb = getHostAndDb(conString);
			const timerState = {};
			const timer = setConnectTimeout(reject,
				new Error(`connect to connection pool for database "${hostAndDb.database}" on host "${hostAndDb.host}" failed.  Error:  Connect timeout after ${_private.connectTimeout} millisec`),
				timerState);
			pg.connect(conString, (err, client, done) => {
				try {
					clearTimeout(timer);
					if (err) {
						logError(err, `attempt to retrieve pooled connection for database "${hostAndDb.database}" on host "${hostAndDb.host}" failed.`);
						reject(err);
					}
					else {
						const dbClient = {dbClient: client, releaseClient: done};
						// timer has expired so Promise has already been rejected.  close returned client since it will never be used.
						if (timerState.expired) {
							logInfo(`closing pooled connection to database "${hostAndDb.database}" on host "${hostAndDb.host}" that was returned after connection timeout`);
							dbUtils.close(dbClient);
						}
						// timer has not expired so return client.
						else {
							resolve(dbClient);
						}
					}
				}
				catch(err) {
					reject(err);
				}
			});
		});
	},
	createQueryStream: (client, statement, prepareStmtParams, options) => {
		const optionsCopy = R.pick(['highWaterMark', 'batchSize'], R.merge(options, _private.queryStreamOptions));
		return client.query(new QueryStream(statement, prepareStmtParams, optionsCopy))
	},
	executeSQLStatement: (client, statement, prepareStmtParams) => {
		prepareStmtParams = prepareStmtParams || [];
		return new Promise((resolve, reject) => {
			client.query(statement, prepareStmtParams, (err, result) => {
				try {
					if (err) {
						logError(err, `query failed:  "${statement.substr(0, 200)}"... for database (${client.database || 'N/A'})`);
						reject(err);
					}
					else {
						resolve(result);
					}
				}
				catch(err) {
					reject(err);
				}
			});
		});
	},
	close: (client, err) => {
		// pooled client
		if (client.releaseClient) {
			// this ensures that a client connection is not returned back to connection pool in the middle of a transaction.
			if (client.__inSlateTransaction) {
				throw new Error(`client connection ${client.dbClient.processID} is in a transaction`);
			}
			// passing truthy err will destroy client rather than returning client to pool.
			client.releaseClient(err);
		}
		// non-pooled client
		else {
			client.end();
		}
	},
	lockEntities: co.wrap(function *(client, entityIds) {
		const entityLocks = R.map(createLockValue, entityIds);
		let result = yield dbUtils.executeSQLStatement(client, 'BEGIN');
		client.__inSlateTransaction = true;
		let gotAllLocks = null;
		yield cRu.forEachG(function *(entityLock) {
			if (gotAllLocks !== false) {
				result = yield dbUtils.executeSQLStatement(client, `SELECT pg_try_advisory_xact_lock(${entityLock.high}, ${entityLock.low})`);
				if (result.rowCount === 1 && result.rows[0].pg_try_advisory_xact_lock === true) {
					gotAllLocks = true;
				}
				else {
					yield dbUtils.rollback(client);
					gotAllLocks = false;
				}
			}
		}, entityLocks);
		// no attempts were made to get an advisory lock.  this could happen if entityIds array is empty.
		if (gotAllLocks === null) {
			yield dbUtils.rollback(client);
			throw new Error(`No attempt to get advisory transaction locks was made.  entityIds may be an empty array.  entityIds:  ${JSON.stringify(entityIds)}`);
		}
		// at least one attempt was made to get an advisory lock
		else {
			return gotAllLocks;
		}
	}),
	commit: co.wrap(function * (client) {
		yield dbUtils.executeSQLStatement(client, 'COMMIT');
		client.__inSlateTransaction = false;
	}),
	rollback: co.wrap(function * (client) {
		yield dbUtils.executeSQLStatement(client, 'ROLLBACK');
		client.__inSlateTransaction = false;
	})
};

module.exports = dbUtils;

