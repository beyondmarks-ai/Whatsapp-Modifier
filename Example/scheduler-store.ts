import { Mutex } from 'async-mutex'
import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { randomUUID } from 'crypto'

export type ScheduledMessage = {
	id: string
	jid: string
	text: string
	scheduledFor: string
	nextAttemptAt: string
	createdAt: string
	status: 'pending' | 'sending' | 'sent' | 'failed'
	attempts: number
	sentAt?: string
}

export type SchedulerChat = {
	id: string
	name: string
	type: 'direct' | 'group'
}

type ChatInput = { id?: string | null; name?: string | null }
type ContactInput = {
	id?: string
	lid?: string
	phoneNumber?: string
	name?: string
	notify?: string
	verifiedName?: string
}

const isDate = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))

const parseMessage = (value: unknown): ScheduledMessage => {
	if (!value || typeof value !== 'object') {
		throw new Error('schedule file contains an invalid message')
	}

	const message = value as Record<string, unknown>
	if (
		typeof message.id !== 'string' ||
		typeof message.jid !== 'string' ||
		typeof message.text !== 'string' ||
		!isDate(message.scheduledFor) ||
		!isDate(message.nextAttemptAt) ||
		!isDate(message.createdAt) ||
		!['pending', 'sending', 'sent', 'failed'].includes(String(message.status)) ||
		typeof message.attempts !== 'number' ||
		!Number.isInteger(message.attempts) ||
		message.attempts < 0 ||
		(message.sentAt !== undefined && !isDate(message.sentAt))
	) {
		throw new Error('schedule file contains an invalid message')
	}

	return message as ScheduledMessage
}

const parseChat = (value: unknown): SchedulerChat => {
	if (!value || typeof value !== 'object') throw new Error('chat file contains an invalid chat')
	const chat = value as Record<string, unknown>
	if (
		typeof chat.id !== 'string' ||
		typeof chat.name !== 'string' ||
		!['direct', 'group'].includes(String(chat.type))
	) {
		throw new Error('chat file contains an invalid chat')
	}
	return chat as SchedulerChat
}

const writeJson = async (file: string, value: unknown) => {
	const temporaryFile = `${file}.${process.pid}.tmp`
	await writeFile(temporaryFile, JSON.stringify(value, undefined, 2), { encoding: 'utf8', mode: 0o600 })
	await rename(temporaryFile, file)
}

export class ChatDirectory {
	private readonly lock = new Mutex()
	private readonly chats = new Map<string, SchedulerChat>()
	private readonly contactNames = new Map<string, string>()

	constructor(private readonly file: string) {}

	async initialize() {
		await mkdir(dirname(this.file), { recursive: true })
		try {
			const value: unknown = JSON.parse(await readFile(this.file, 'utf8'))
			if (!Array.isArray(value)) throw new Error('chat file must contain an array')
			for (const chat of value.map(parseChat)) this.chats.set(chat.id, chat)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
			await this.save()
		}
	}

	async update(chats: ChatInput[], contacts: ContactInput[]) {
		await this.lock.runExclusive(async () => {
			for (const contact of contacts) {
				const name = contact.name ?? contact.notify ?? contact.verifiedName
				if (!name) continue
				for (const id of [contact.id, contact.lid, contact.phoneNumber]) {
					if (!id) continue
					this.contactNames.set(id, name)
					const existing = this.chats.get(id)
					if (existing) existing.name = name
				}
			}

			for (const chat of chats) {
				const id = chat.id?.replace(/:\d+@/, '@')
				if (!id || (!id.endsWith('@s.whatsapp.net') && !id.endsWith('@lid') && !id.endsWith('@g.us'))) continue
				const existing = this.chats.get(id)
				const fallback = id.slice(0, id.indexOf('@'))
				this.chats.set(id, {
					id,
					name: chat.name ?? this.contactNames.get(id) ?? existing?.name ?? fallback,
					type: id.endsWith('@g.us') ? 'group' : 'direct'
				})
			}

			await this.save()
		})
	}

	async remove(ids: string[]) {
		await this.lock.runExclusive(async () => {
			for (const id of ids) this.chats.delete(id.replace(/:\d+@/, '@'))
			await this.save()
		})
	}

	async clear() {
		await this.lock.runExclusive(async () => {
			this.chats.clear()
			this.contactNames.clear()
			await this.save()
		})
	}

	async list() {
		return this.lock.runExclusive(() =>
			[...this.chats.values()].map(chat => ({ ...chat })).sort((left, right) => left.name.localeCompare(right.name))
		)
	}

	async has(id: string) {
		return this.lock.runExclusive(() => this.chats.has(id.replace(/:\d+@/, '@')))
	}

	private async save() {
		await writeJson(this.file, [...this.chats.values()])
	}
}

export class ScheduleStore {
	// ponytail: one-process JSON store; use a transactional database for multiple workers or large queues.
	private readonly lock = new Mutex()
	private messages: ScheduledMessage[] = []

	constructor(private readonly file: string) {}

	async initialize() {
		await mkdir(dirname(this.file), { recursive: true })
		try {
			const value: unknown = JSON.parse(await readFile(this.file, 'utf8'))
			if (!Array.isArray(value)) {
				throw new Error('schedule file must contain an array')
			}

			this.messages = value.map(parseMessage)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				throw error
			}

			await this.save()
		}

		const interrupted = this.messages.filter(message => message.status === 'sending')
		if (interrupted.length) {
			const now = new Date().toISOString()
			for (const message of interrupted) {
				message.status = 'pending'
				message.nextAttemptAt = now
			}
			await this.save()
		}
	}

	async list() {
		return this.lock.runExclusive(() => this.messages.map(message => ({ ...message })))
	}

	async add(jid: string, text: string, scheduledFor: Date) {
		return this.lock.runExclusive(async () => {
			const now = new Date().toISOString()
			const message: ScheduledMessage = {
				id: randomUUID(),
				jid,
				text,
				scheduledFor: scheduledFor.toISOString(),
				nextAttemptAt: scheduledFor.toISOString(),
				createdAt: now,
				status: 'pending',
				attempts: 0
			}
			this.messages.push(message)
			await this.save()
			return { ...message }
		})
	}

	async claimDue(now: Date) {
		return this.lock.runExclusive(async () => {
			const message = this.messages.find(
				candidate => candidate.status === 'pending' && Date.parse(candidate.nextAttemptAt) <= now.getTime()
			)
			if (!message) return undefined

			message.status = 'sending'
			await this.save()
			return { ...message }
		})
	}

	async markSent(id: string, sentAt = new Date()) {
		await this.update(id, message => {
			message.status = 'sent'
			message.sentAt = sentAt.toISOString()
		})
	}

	async markFailed(id: string, now = new Date()) {
		await this.update(id, message => {
			message.attempts += 1
			message.status = message.attempts >= 5 ? 'failed' : 'pending'
			message.nextAttemptAt = new Date(
				now.getTime() + Math.min(60_000 * 2 ** message.attempts, 15 * 60_000)
			).toISOString()
		})
	}

	async remove(id: string) {
		return this.lock.runExclusive(async () => {
			const index = this.messages.findIndex(message => message.id === id)
			if (index < 0) return false

			this.messages.splice(index, 1)
			await this.save()
			return true
		})
	}

	private async update(id: string, change: (message: ScheduledMessage) => void) {
		await this.lock.runExclusive(async () => {
			const message = this.messages.find(candidate => candidate.id === id)
			if (!message) throw new Error(`scheduled message not found: ${id}`)
			change(message)
			await this.save()
		})
	}

	private async save() {
		await writeJson(this.file, this.messages)
	}
}
