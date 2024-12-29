export const LogLevel = {
	SILENT: 0,
	DEBUG: 1,
	INFO: 2,
	WARN: 3,
	ERROR: 4,
} as const;

export type LogLevelType = (typeof LogLevel)[keyof typeof LogLevel];

let globalLogLevel: LogLevelType = LogLevel.SILENT;

export class Logger {
	debug(message: unknown, ...optionalParams: unknown[]) {
		if (globalLogLevel > LogLevel.SILENT && globalLogLevel <= LogLevel.DEBUG) {
			console.debug(message, ...optionalParams);
		}
	}

	info(message: unknown, ...optionalParams: unknown[]) {
		if (globalLogLevel > LogLevel.SILENT && globalLogLevel <= LogLevel.INFO) {
			console.info(message, ...optionalParams);
		}
	}

	warn(message: unknown, ...optionalParams: unknown[]) {
		if (globalLogLevel > LogLevel.SILENT && globalLogLevel <= LogLevel.WARN) {
			console.warn(message, ...optionalParams);
		}
	}

	error(message: unknown, ...optionalParams: unknown[]) {
		if (globalLogLevel > LogLevel.SILENT && globalLogLevel <= LogLevel.ERROR) {
			console.error(message, ...optionalParams);
		}
	}
	setGlobalLevel(level: LogLevelType) {
		globalLogLevel = level;
	}
}

export const log = new Logger();
