import App from "./app"
import { CommandOptions, Middleware, Properties } from "./interface"
import { findCommand, parseTextMessage } from "./utils"
import P from 'pino'
import {AnyMessageContent, MiscMessageGenerationOptions, WASocket} from '@adiwajshing/baileys'
import disabledMiddleware from "./middlewares/disabled"

const logger = P()

const GLOBAL_PREFIX = '/'

const COMMANDS = {}

let _sock: WASocket

const pendingStart = []

let firstStart = true

let queueIsRunning = false

const queue = []

function start (sock) {
    _sock = sock

    _sock.ev.on('messages.upsert', async m => {
        if (m.type !== 'notify') {
            return
        }

        for (const msg of m.messages) {
            const body = parseTextMessage(msg.message)
            let command: string = null
            let middlewares: Middleware[] = null
            let textMessage: string = null

            /**
             * Split the command from the conversation.
             * Default use global prefix set above.
             * When the command exists, get the middleware,
             * and remove the command from the conversation,
             * so it has clear text without the command.
             */
            if (typeof body === 'string' && body[0] === '/') {
                const commandEndIndex= body.indexOf(' ')
                command = body.slice(GLOBAL_PREFIX.length, commandEndIndex < 0 ? body.length : commandEndIndex)

                const ITEM = findCommand(COMMANDS, command)

                if (!ITEM) {
                    continue
                }

                middlewares = ITEM.middlewares

                textMessage = body.replace(GLOBAL_PREFIX + command, '').trim()
            } else {
                return
            }

            /**
             * Get the basic properties
             */
            const properties: Properties = {
                command,
                fromMe: msg.key.fromMe || false,
                isGroup: (msg.key.remoteJid || '').endsWith('@g.us') || false,
                fromJid: null,
                groupJid: null,
                textMessage,
                message: msg.message,
                remoteJid: msg.key.remoteJid,
            }

            if (properties.isGroup) {
                properties.groupJid = msg.key.remoteJid
                properties.fromJid = msg.key.participant
            }
            else {
                properties.fromJid = msg.key.remoteJid
            }

            /**
             * Execute all the middleware
             */
            await handleCommand(middlewares, _sock, properties)
        }
	})

    _sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update

        if (connection === 'open') {
            if (firstStart) {
                for (const cb of pendingStart) {
                    cb(_sock)
                }

                firstStart = false
            }
            processQueue()
        }
    })
}

async function handleCommand (middlewares: Middleware[], sock: WASocket, properties: Properties) {
    for (const middleware of middlewares) {
        let next = false

        await middleware(sock, properties, () => { next = true })

        if (!next) {
            break
        }
    }
}

function set (command: string, properties: CommandOptions, ...middlewares: Middleware[]) {
    if (properties.disabled) {
        COMMANDS[command] = {
            properties,
            middlewares: [disabledMiddleware],
        }

        logger.error(`command \`${command} disabled`)
    } else {
        COMMANDS[command] = {
            properties,
            middlewares,
        }

        logger.info(`command \`${command}\` set`)
    }
}

function use (app: App) {
    const commands = app.getCommands()

    for (const c of commands) {
        if (c.properties.disabled) {
            COMMANDS[c.command] = {
                properties: c.properties,
                middlewares: [disabledMiddleware],
            }

            logger.error(`command \`${c.command} from \`${app.module}\` module is disabled`)
        } else {
            COMMANDS[c.command] = {
                properties: c.properties,
                middlewares: c.middlewares,
            }

            logger.info(`command \`${c.command}\` from \`${app.module}\` module is set`)
        }
    }
}

function validateCommand (command: string) {
    return Object.keys(COMMANDS).includes(command)
}

function commandLists () {
    return COMMANDS
}

function getSock(cb) {
    pendingStart.push(cb)
}

export function addQueue(jid: string, message: AnyMessageContent, options?: MiscMessageGenerationOptions) {
    queue.push({ jid, message, options })
    processQueue()
}

async function processQueue() {
    if (queueIsRunning) {
        return
    }
    logger.info('processing queue')
    queueIsRunning = true
    while (queue.length) {
        try {
            const item = queue[0]
            await _sock.sendMessage(item.jid, item.message, item.options)
            queue.shift()
        } catch (e) {
            const item = queue[0]
            logger.error(`queue failed: ${item.jid} - ${item.message}`)
            queue.shift()
        }
    }
    queueIsRunning = false
}

export default {
    start,
    set,
    commandLists,
    App,
    use,
    validateCommand,
    getSock,
}
