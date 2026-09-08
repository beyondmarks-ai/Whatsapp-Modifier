import { timingSafeEqual } from 'crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { readFile, rm } from 'fs/promises'
import { join } from 'path'
import type { Boom } from '@hapi/boom'
import P from 'pino'
import makeWASocket, {
	DisconnectReason,
	isJidGroup,
	jidNormalizedUser,
	makeCacheableSignalKeyStore,
	useMultiFileAuthState,
	type WASocket
} from '../lib/index.js'
import { ChatDirectory, ScheduleStore } from './scheduler-store.js'

class HttpError extends Error {
	constructor(
		message: string,
		readonly statusCode: number
	) {
		super(message)
	}
}

const requireString = (value: unknown, name: string) => {
	if (typeof value !== 'string' || !value.trim()) {
		throw new HttpError(`${name} must be a non-empty string`, 400)
	}
	return value.trim()
}

const phoneNumber = (value: unknown) => {
	const phone = requireString(value, 'phone')
	if (!/^\d{7,15}$/.test(phone)) {
		throw new HttpError('phone must contain 7-15 digits including the country code', 400)
	}
	return phone
}

const phoneToJid = (value: unknown) => jidNormalizedUser(`${phoneNumber(value)}@s.whatsapp.net`)

const readJson = async (request: IncomingMessage) => {
	let body = ''
	for await (const chunk of request) {
		body += String(chunk)
		if (body.length > 64 * 1024) throw new HttpError('request body is too large', 413)
	}

	try {
		const value: unknown = JSON.parse(body)
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new HttpError('request body must be a JSON object', 400)
		}
		return value as Record<string, unknown>
	} catch (error) {
		if (error instanceof HttpError) throw error
		throw new HttpError('request body must be valid JSON', 400)
	}
}

const sendJson = (response: ServerResponse, statusCode: number, body: unknown) => {
	response.writeHead(statusCode, {
		'cache-control': 'no-store',
		'content-type': 'application/json; charset=utf-8',
		'x-content-type-options': 'nosniff'
	})
	response.end(JSON.stringify(body))
}

const sendHtml = (response: ServerResponse, body: string) => {
	response.writeHead(200, {
		'cache-control': 'no-store',
		'content-security-policy':
			"default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
		'content-type': 'text/html; charset=utf-8',
		'referrer-policy': 'no-referrer',
		'x-content-type-options': 'nosniff'
	})
	response.end(body)
}

const authorized = (request: IncomingMessage, token: string) => {
	const prefix = 'Bearer '
	const header = request.headers.authorization
	if (!header?.startsWith(prefix)) return false

	const expected = Buffer.from(token)
	const supplied = Buffer.from(header.slice(prefix.length))
	return expected.length === supplied.length && timingSafeEqual(expected, supplied)
}

const main = async () => {
	const logger = P({ level: process.env.LOG_LEVEL ?? 'info' })
	const token = process.env.SCHEDULER_TOKEN
	if (!token || Buffer.byteLength(token) < 32) {
		throw new Error('SCHEDULER_TOKEN must contain at least 32 bytes')
	}

	const port = Number(process.env.PORT ?? 3000)
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error('PORT must be a valid TCP port')
	}

	const dataDirectory = process.env.DATA_DIR ?? '.scheduler-data'
	const authDirectory = join(dataDirectory, 'auth')
	const store = new ScheduleStore(join(dataDirectory, 'messages.json'))
	const chatDirectory = new ChatDirectory(join(dataDirectory, 'chats.json'))
	const dashboard = await readFile(new URL('./scheduler.html', import.meta.url), 'utf8')
	await Promise.all([store.initialize(), chatDirectory.initialize()])
	await chatDirectory.update(
		(await store.list()).map(message => ({ id: message.jid })),
		[]
	)

	let socket: WASocket | undefined
	let connected = false
	let reconnectTimer: NodeJS.Timeout | undefined
	let processing = false
	let shuttingDown = false
	let resetting = false

	const startSocket = async () => {
		const { state, saveCreds } = await useMultiFileAuthState(authDirectory)
		const nextSocket = makeWASocket({
			logger,
			auth: {
				creds: state.creds,
				keys: makeCacheableSignalKeyStore(state.keys, logger)
			}
		})
		socket = nextSocket

		nextSocket.ev.on('creds.update', () => {
			void saveCreds().catch(error => logger.error({ err: error }, 'failed to save credentials'))
		})
		nextSocket.ev.on('connection.update', update => {
			if (update.connection === 'open') {
				connected = true
				logger.info('WhatsApp connection opened')
				void nextSocket
					.groupFetchAllParticipating()
					.then(groups =>
						chatDirectory.update(
							Object.values(groups).map(group => ({ id: group.id, name: group.subject })),
							[]
						)
					)
					.catch(error => logger.warn({ err: error }, 'failed to load groups'))
			}

			if (update.connection === 'close') {
				connected = false
				if (shuttingDown || resetting) return
				const statusCode = (update.lastDisconnect?.error as Boom | undefined)?.output?.statusCode
				if (statusCode === DisconnectReason.loggedOut) {
					logger.error('WhatsApp account logged out; pair it again')
					return
				}

				if (!reconnectTimer) {
					reconnectTimer = setTimeout(() => {
						reconnectTimer = undefined
						void startSocket().catch(error => logger.error({ err: error }, 'failed to reconnect to WhatsApp'))
					}, 2_000)
				}
			}
		})
		nextSocket.ev.on('messaging-history.set', ({ chats, contacts }) => {
			void chatDirectory.update(chats, contacts).catch(error => logger.error({ err: error }, 'failed to save chats'))
		})
		nextSocket.ev.on('chats.upsert', chats => {
			void chatDirectory.update(chats, []).catch(error => logger.error({ err: error }, 'failed to save chats'))
		})
		nextSocket.ev.on('chats.update', chats => {
			void chatDirectory.update(chats, []).catch(error => logger.error({ err: error }, 'failed to save chats'))
		})
		nextSocket.ev.on('chats.delete', ids => {
			void chatDirectory.remove(ids).catch(error => logger.error({ err: error }, 'failed to remove chats'))
		})
		nextSocket.ev.on('contacts.upsert', contacts => {
			void chatDirectory.update([], contacts).catch(error => logger.error({ err: error }, 'failed to save contacts'))
		})
		nextSocket.ev.on('contacts.update', contacts => {
			void chatDirectory.update([], contacts).catch(error => logger.error({ err: error }, 'failed to save contacts'))
		})
		nextSocket.ev.on('messages.upsert', ({ messages }) => {
			const chats = messages.flatMap(message => {
				const id = message.key.remoteJid
				return id ? [{ id, name: isJidGroup(id) || message.key.fromMe ? undefined : message.pushName }] : []
			})
			void chatDirectory.update(chats, []).catch(error => logger.error({ err: error }, 'failed to save chats'))
		})
	}

	await startSocket()

	const processDueMessages = async () => {
		if (processing || !connected || !socket) return
		processing = true
		try {
			while (connected && socket) {
				const message = await store.claimDue(new Date())
				if (!message) break

				try {
					await socket.sendMessage(message.jid, { text: message.text })
					await store.markSent(message.id)
					logger.info({ jobId: message.id }, 'scheduled message sent')
				} catch (error) {
					await store.markFailed(message.id)
					logger.error({ err: error, jobId: message.id }, 'scheduled message failed')
				}
			}
		} finally {
			processing = false
		}
	}

	const timer = setInterval(() => {
		void processDueMessages().catch(error => logger.error({ err: error }, 'failed to process scheduled messages'))
	}, 1_000)

	const server = createServer(async (request, response) => {
		try {
			const url = new URL(request.url ?? '/', 'http://localhost')
			if (request.method === 'GET' && url.pathname === '/') {
				sendHtml(response, dashboard)
				return
			}
			if (request.method === 'GET' && url.pathname === '/health') {
				sendJson(response, 200, { ok: true, connected })
				return
			}

			if (!authorized(request, token)) {
				throw new HttpError('unauthorized', 401)
			}

			if (request.method === 'POST' && url.pathname === '/pair') {
				if (!socket) throw new HttpError('WhatsApp socket is not ready', 503)
				if (socket.authState.creds.registered) {
					throw new HttpError('WhatsApp account is already paired', 409)
				}
				const body = await readJson(request)
				const code = await socket.requestPairingCode(phoneNumber(body.phone))
				sendJson(response, 200, { code })
				return
			}

			if (request.method === 'POST' && url.pathname === '/session/reset') {
				resetting = true
				connected = false
				if (reconnectTimer) {
					clearTimeout(reconnectTimer)
					reconnectTimer = undefined
				}
				const previousSocket = socket
				socket = undefined
				try {
					await previousSocket?.logout()
				} catch (error) {
					logger.warn({ err: error }, 'failed to log out previous WhatsApp session')
				}
				try {
					await rm(authDirectory, { recursive: true, force: true })
					await chatDirectory.clear()
				} finally {
					resetting = false
				}
				await startSocket()
				sendJson(response, 204, undefined)
				return
			}

			if (request.method === 'POST' && url.pathname === '/messages') {
				const body = await readJson(request)
				const text = requireString(body.text, 'text')
				if (text.length > 4_096) throw new HttpError('text must not exceed 4096 characters', 400)
				const sendAt = new Date(requireString(body.sendAt, 'sendAt'))
				if (!Number.isFinite(sendAt.getTime()) || sendAt.getTime() <= Date.now()) {
					throw new HttpError('sendAt must be a future ISO-8601 date', 400)
				}

				let jid: string
				if (body.jid === undefined) {
					jid = phoneToJid(body.phone)
				} else {
					jid = requireString(body.jid, 'jid').replace(/:\d+@/, '@')
					if (!(await chatDirectory.has(jid))) throw new HttpError('jid must be a known chat', 400)
				}

				const message = await store.add(jid, text, sendAt)
				sendJson(response, 201, message)
				return
			}

			if (request.method === 'GET' && url.pathname === '/chats') {
				sendJson(response, 200, await chatDirectory.list())
				return
			}

			if (request.method === 'GET' && url.pathname === '/messages') {
				sendJson(response, 200, await store.list())
				return
			}

			const deleteMatch = request.method === 'DELETE' ? url.pathname.match(/^\/messages\/([\w-]+)$/) : undefined
			if (deleteMatch?.[1]) {
				if (!(await store.remove(deleteMatch[1]))) {
					throw new HttpError('scheduled message not found', 404)
				}
				sendJson(response, 204, undefined)
				return
			}

			throw new HttpError('not found', 404)
		} catch (error) {
			const statusCode = error instanceof HttpError ? error.statusCode : 500
			if (statusCode === 500) logger.error({ err: error }, 'request failed')
			sendJson(response, statusCode, {
				error: statusCode === 500 ? 'internal server error' : (error as Error).message
			})
		}
	})
	server.headersTimeout = 10_000
	server.requestTimeout = 15_000

	server.listen(port, () => logger.info({ port }, 'scheduler listening'))

	const shutdown = () => {
		shuttingDown = true
		clearInterval(timer)
		if (reconnectTimer) clearTimeout(reconnectTimer)
		server.close()
		socket?.end(new Error('process shutting down'))
	}
	process.once('SIGINT', shutdown)
	process.once('SIGTERM', shutdown)
}

void main().catch(error => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
	process.exitCode = 1
})
