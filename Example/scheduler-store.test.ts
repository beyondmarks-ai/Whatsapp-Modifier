import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ChatDirectory, ScheduleStore } from './scheduler-store.js'

test('persists messages and retries interrupted sends', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'baileys-scheduler-'))
	try {
		const file = join(directory, 'messages.json')
		const store = new ScheduleStore(file)
		await store.initialize()

		const future = await store.add('1234567890@s.whatsapp.net', 'later', new Date(Date.now() + 60_000))
		assert.equal(await store.claimDue(new Date()), undefined)

		const due = await store.add('1234567890@s.whatsapp.net', 'now', new Date(Date.now() - 1_000))
		assert.equal((await store.claimDue(new Date()))?.id, due.id)

		const restarted = new ScheduleStore(file)
		await restarted.initialize()
		assert.equal((await restarted.claimDue(new Date()))?.id, due.id)
		await restarted.markSent(due.id)
		assert.deepEqual(
			(await restarted.list()).map(message => [message.id, message.status]),
			[
				[future.id, 'pending'],
				[due.id, 'sent']
			]
		)
		assert.equal(JSON.parse(await readFile(file, 'utf8')).length, 2)
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
})

test('persists chats and applies contact names', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'baileys-scheduler-chats-'))
	try {
		const file = join(directory, 'chats.json')
		const chats = new ChatDirectory(file)
		await chats.initialize()
		await chats.update(
			[{ id: '123:4@s.whatsapp.net' }, { id: '456@g.us', name: 'Project group' }, { id: 'status@broadcast' }],
			[{ id: '123@s.whatsapp.net', name: 'Ada' }]
		)

		assert.deepEqual(await chats.list(), [
			{ id: '123@s.whatsapp.net', name: 'Ada', type: 'direct' },
			{ id: '456@g.us', name: 'Project group', type: 'group' }
		])
		assert.equal(await chats.has('123:9@s.whatsapp.net'), true)

		const restarted = new ChatDirectory(file)
		await restarted.initialize()
		assert.deepEqual(await restarted.list(), await chats.list())
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
})
