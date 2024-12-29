export const LogLevel = {
	SILENT: 0,
	DEBUG: 1,
	INFO: 2,
	WARN: 3,
	ERROR: 4,
} as const;

export type LogLevelType = (typeof LogLevel)[keyof typeof LogLevel];

let globalLogLevel: LogLevelType = LogLevel.WARN;

export class Logger {
	debug(message: unknown, ...optionalParams: unknown[]) {
		if (globalLogLevel <= LogLevel.DEBUG) {
			console.debug(message, ...optionalParams);
		}
	}

	info(message: unknown, ...optionalParams: unknown[]) {
		if (globalLogLevel <= LogLevel.INFO) {
			console.info(message, ...optionalParams);
		}
	}

	warn(message: unknown, ...optionalParams: unknown[]) {
		if (globalLogLevel <= LogLevel.WARN) {
			console.warn(message, ...optionalParams);
		}
	}

	error(message: unknown, ...optionalParams: unknown[]) {
		if (globalLogLevel <= LogLevel.ERROR) {
			console.error(message, ...optionalParams);
		}
	}
	setGlobalLevel(level: LogLevelType) {
		globalLogLevel = level;
	}
}

export const log = new Logger();
