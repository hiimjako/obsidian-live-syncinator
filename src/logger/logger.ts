export const Levels = {
	DEBUG: 1,
	INFO: 2,
	WARN: 3,
	ERROR: 4,
} as const;

type Levels = (typeof Levels)[keyof typeof Levels];

let logLevel: Levels = Levels.WARN;

export class Logger {
	debug(message: unknown, ...optionalParams: unknown[]) {
		if (logLevel <= Levels.DEBUG) {
			console.debug(message, ...optionalParams);
		}
	}

	info(message: unknown, ...optionalParams: unknown[]) {
		if (logLevel <= Levels.INFO) {
			console.info(message, ...optionalParams);
		}
	}

	warn(message: unknown, ...optionalParams: unknown[]) {
		if (logLevel <= Levels.WARN) {
			console.warn(message, ...optionalParams);
		}
	}

	error(message: unknown, ...optionalParams: unknown[]) {
		if (logLevel <= Levels.ERROR) {
			console.error(message, ...optionalParams);
		}
	}
}

export function setGlobalLevel(level: Levels) {
	logLevel = level;
}
export const log = new Logger();
