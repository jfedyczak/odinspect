const fs = require('fs')
const child_process = require('child_process')
const usbDetect = require('usb-detection')
const EventEmitter = require('events')
const Promise = require('bluebird')
const Message = require('bitcore-message')
const http = require('http')
const https = require('https')
const url = require('url')
const send = require('send')
const WebSocket = require('ws')

const httpGet = (addr) => {
	return new Promise((resolve, reject) => {
		addr = url.parse(addr)
		let response = Buffer.from([])
		let req = (addr.protocol == 'https:' ? https : http).request(addr, (res) => {
			if (res.statusCode != 200)
				return reject(new KnownError('Unable to check balance online'))
			res.on('data', (data) => {
				response = Buffer.concat([response, data])
			})
			res.on('end', () => {
				resolve(response.toString('utf8'))
			})
		})
		.on('error', (e) => {
			console.log(e)
			reject(e)
		})
		.end()
	})
}

const readFile = (filename) => {
	return new Promise((resolve, reject) => {
		fs.readFile(filename, {encoding: 'utf8'}, (err, data) => {
			if (err) return resolve(null)
			return resolve(data)
		})
	})
}

const settle = (data) => {
	console.log(` -- waiting for udev to settle...`);
	return new Promise((resolve, reject) => {
		child_process.exec('udevadm settle', (err, stdout, stderr) => {
			if (err) return reject(err)
			setTimeout(() => {
				return resolve(data)
			}, 10)
		})
	})
}
const findBlockDev = (data) => {
	console.log(` -- searching for block device ${data.usbSerialNumber}`);
	return new Promise((resolve, reject) => {
		child_process.exec('lsblk -b -J -o NAME,VENDOR,SERIAL', (err, stdout, stderr) => {
			if (err) return reject(err)
			let dev = JSON.parse(stdout).blockdevices
				.filter((d) => d.vendor === 'Opendime')
				.filter((d) => d.serial === data.usbSerialNumber)
				.map((d) => d.children[0].name)
			console.log(dev)
			if (dev.length !== 1) return reject(new KnownError('Block device not found'))
			data.dev = dev[0]
			return resolve(data)
		})
	})
}

const mountDev = (devData) => {
	console.log(` -- mounting ${devData.dev}...`);
	return new Promise((resolve, reject) => {
		child_process.exec(`mount /dev/${devData.dev} /mnt`, (err, stdout, stderr) => {
			if (err) return reject(err)
			return resolve(devData)
		})
	})
}

const umountDev = (devData) => {
	console.log(` -- unmounting ${devData.dev}...`);
	return new Promise((resolve, reject) => {
		child_process.exec(`umount /mnt`, (err, stdout, stderr) => {
			if (err) return reject(err)
			return resolve(devData)
		})
	})
}

const readData = (devData) => {
	return readFile('/mnt/advanced/variables.json')
	.then((vars) => {
		devData.vars = JSON.parse(vars)
		return devData
	})
}

const verifySig = (devData) => {
	return Promise.try(() => {
		if (devData.vars.va) {
			let t = devData.vars.va.split('|')
			let msg = t[0]
			let addr = t[1]
			let sig = t[2]
			devData.verified = Message(msg).verify(addr, sig)
			if (devData.verified)
				devData.address = addr
		}
		return devData
	})
}

const formatBTC = (satoshi) => {
	let full = Math.floor(satoshi / 100000000).toString(10)
	let part = (satoshi % 100000000).toString(10)
	while (part.length < 8) part = `0${part}`
	while (part.endsWith('0')) part = part.slice(0, -1)
	if (part.length) part = `.${part}`
	return `${full}${part}`
}

const checkBalance = (devData) => {
	return Promise.try(() => {
		if (devData.verified)
			return httpGet(`https://blockchain.info/balance?active=${devData.address}`)
			.then((resp) => {
				let balance = JSON.parse(resp)[devData.address].final_balance
				devData.balance = formatBTC(balance)
				return devData
			})
		else
			return devData
	})
}

class KnownError extends Error {
	constructor(msgForTheUser) {
		super(msgForTheUser)
		this.msgForTheUser = msgForTheUser
	}
	getMsg() {
		return this.msgForTheUser
	}
}

class ODEmitter extends EventEmitter {}

const odEmitter = new ODEmitter()

let globalData = {
	status: 'IDLE'
}
const setGlobalStatus = (data) => {
	wss.clients.forEach((ws) => {
		globalData = data
		ws.send(JSON.stringify(data))
	})
}

usbDetect.on('add:53566:256', (device) => {
	console.log(' -- matching USB device found')
	setGlobalStatus({
		status: 'READING'
	})
	
	Promise.try(() => {
		if (device.deviceName !== 'Opendime_by_Coinkite')
			throw new KnownError(`Wrong device name: ${device.deviceName}`)
		if (device.manufacturer !== 'Opendime')
			throw new KnownError('Wrong manufacturer: ${device.manufacturer}')
		return {
			status: 'READY',
			usbSerialNumber: device.serialNumber
		}
	})
	.then(settle)
	.then(findBlockDev)
	.then(mountDev)
	.then(readData)
	.then(umountDev)
	.then(verifySig)
	.then((devData) => {
		setGlobalStatus({
			status: 'BALANCE'
		})		
		return checkBalance(devData)
	})
	.then((devData) => {
		setGlobalStatus(devData)
		console.log(devData)
	})
	.catch((e) => {
		console.log(e)
	})
})

usbDetect.on('remove:53566:256', (device) => {
	console.log(' -- removed')
	setGlobalStatus({
		status: 'IDLE'
	})
})
fs.writeFileSync('/sys/module/usb_storage/parameters/delay_use', '0')

const srv = http.createServer()
.on('request', (req, res) => {
	req.query = url.parse(req.url)
	if (req.query.pathname == '/dupa') {
	} else {
		send(req, req.query.pathname, {
			root: `${__dirname}/public`,
		}).pipe(res)
	}
})
.listen(80)

const wss = new WebSocket.Server({ server: srv })
.on('connection', (ws, req) => {
	console.log(' -- new conn')
	ws.alive = true
	ws.on('pong', function() { this.alive = true })
	ws.send(JSON.stringify(globalData))
})

setInterval(() => {
	wss.clients.forEach((ws) => {
		if (!ws.alive) {
			console.log(' -- closing WS conn')
			return ws.terminate()
		}
		ws.alive = false
		ws.ping('', false, true)
	})
}, 15000)

console.log(' -- ready')
