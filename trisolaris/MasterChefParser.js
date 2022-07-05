const Web3 = require('web3')
const { toBN, toWei, fromWei } = Web3.utils
const axios = require('axios')
const Addresses = require("./Addresses.js")
const fs = require('fs');

/**
 * a small retry wrapper with an incrameting 5s sleep delay
 * @param {*} fn 
 * @param {*} params 
 * @param {*} retries 
 * @returns 
 */
async function retry(fn, params, retries = 0) {
    try {
        const res = await  fn(...params)
        if(retries){
            console.log(`retry success after ${retries} retries`)
        } else {
            console.log(`success on first try`)
        }
        return res
    } catch (e) {
        console.error(e)
        retries++
        console.log(`retry #${retries}`)
        await new Promise(resolve => setTimeout(resolve, 1000 * 5 * retries))
        return retry(fn, params, retries)
    }
}

class MasterChef {
    constructor(name, pid, masterchefInfo, network, web3, heavyUpdateInterval = 24) {
      this.web3 = web3
      this.heavyUpdateInterval = heavyUpdateInterval
      this.deployBlock = masterchefInfo[network].deployBlock
      this.blockStepInInit = masterchefInfo[network].blockStepInInit
      this.multicallSize = masterchefInfo[network].multicallSize
      this.version = masterchefInfo[network].version
      this.name = name

      if(this.version === 1) {
        this.masterChef = new web3.eth.Contract(Addresses.masterChefV1Abi, masterchefInfo[network].address)
      }
      else if(this.version === 2) {
        this.masterChef = new web3.eth.Contract(Addresses.masterChefV2Abi, masterchefInfo[network].address)        
      }
      this.multicall = new web3.eth.Contract(Addresses.multicallAbi, Addresses.multicallAddress[network])
      this.users = {}
      this.pid = pid
      this.market = []

      this.output = {}

      this.mainCntr = 0
      this.userList = []

      this.totalSupply = 0
      this.balances = {}
    }

    getData() {
        const result =
        {
            "name" : this.name,
            "lastUpdateTime" : this.lastUpdateTime,
            "lp" : JSON.stringify(this.market),
            "totalSupply" : this.totalSupply,
            "underlyingBalances" : JSON.stringify(this.balances),
            "users" : JSON.stringify(this.users)
        }
        try {
            fs.writeFileSync("data_" + this.name + ".json", JSON.stringify(result));
            // file written successfully
          } catch (err) {
            console.error(err);
          } 
        return JSON.stringify(result)
    }

    async heavyUpdate() {
        const currBlock = await this.web3.eth.getBlockNumber() - 10      

        if(this.userList.length == 0) await this.collectAllUsers()
        await this.updateAllUsers()
    }

    async lightUpdate() {
        const currBlock = await this.web3.eth.getBlockNumber() - 10

        await this.periodicUpdateUsers(this.lastUpdateBlock)
        //await this.calcBadDebt(currTime) 
    }

    async main(onlyOnce = false) {
        try {
            await this.init()
                        
            const currBlock = await this.web3.eth.getBlockNumber() - 10
            const currTime = (await this.web3.eth.getBlock(currBlock)).timestamp

            if(this.mainCntr % this.heavyUpdateInterval == 0) {
                console.log("heavyUpdate start")
                await this.heavyUpdate()
                console.log('heavyUpdate success')
            } else {
                console.log("lightUpdate start")
                await this.lightUpdate()
                console.log('lightUpdate success')
            }

            this.lastUpdateBlock = currBlock
            this.lastUpdateTime = currTime

            // don't  increase cntr, this way if heavy update is needed, it will be done again next time
            console.log("sleeping", this.mainCntr++)
        }
        catch(err) {
            console.log("main failed", {err})
        }

        console.log("============================")
        console.log(this.getData())

        if(! onlyOnce) setTimeout(this.main.bind(this), 1000 * 60 * 60) // sleep for 1 hour
    }

    async init() {
        let lpTokenAddress
        if(this.version === 1) {
            const poolInfo = await this.masterChef.methods.poolInfo(this.pid).call()
            lpTokenAddress = poolInfo.lpToken
        }
        else if(this.version === 2) {
            lpTokenAddress = await this.masterChef.methods.lpToken(this.pid).call()
        }

        const lpToken = new this.web3.eth.Contract(Addresses.uniLPV2Abi, lpTokenAddress)

        const token0 = await lpToken.methods.token0().call()
        const token1 = await lpToken.methods.token1().call()
        this.totalSupply = await lpToken.methods.totalSupply().call()

        this.market = [token0, token1]

        for(const token of this.market) {
            const tokenContract = new this.web3.eth.Contract(Addresses.erc20Abi, token)
            this.balances[token] = await tokenContract.methods.balanceOf(lpTokenAddress).call()
        }

        console.log("init: market ", JSON.stringify(this.market))
    }


    async getPastEventsInSteps(cToken, key, from, to, filter){
        let totalEvents = []
        for (let i = from; i < to; i = i + this.blockStepInInit) {
            const fromBlock = i
            const toBlock = i + this.blockStepInInit > to ? to : i + this.blockStepInInit
            const fn = (...args) => cToken.getPastEvents(...args)
            const events = await retry(fn, [key, {filter, fromBlock, toBlock}])
            totalEvents = totalEvents.concat(events)
        }
        return totalEvents
    }
    
    async periodicUpdateUsers(lastUpdatedBlock) {
        const accountsToUpdate = []
        const currBlock = await this.web3.eth.getBlockNumber() - 10
        console.log({currBlock})

        const events = {"Deposit" : ["user"],
                        "Withdraw" : ["user"]}

        const keys = Object.keys(events)
        console.log({keys})
        for (const key of keys) {
            const value = events[key]
            console.log({key}, {value})
            const newEvents = await this.getPastEventsInSteps(this.masterChef, key, lastUpdatedBlock, currBlock, {pid : [this.pid]}) 
            for(const e of newEvents) {
                console.log("pid", e.returnValues.pid)
                for(const field of value) {
                    console.log({field})
                    const a = e.returnValues[field]
                    console.log({a})
                    if(! accountsToUpdate.includes(a)) accountsToUpdate.push(a)
                }
            }
        }

        console.log({accountsToUpdate})
        for(const a of accountsToUpdate) {
            if(! this.userList.includes(a)) this.userList.push(a)            
        }
        // updating users in slices
        const bulkSize = this.multicallSize
        for (let i = 0; i < accountsToUpdate.length; i = i + bulkSize) {
            const to = i + bulkSize > accountsToUpdate.length ? accountsToUpdate.length : i + bulkSize
            const slice = accountsToUpdate.slice(i, to)
            const fn = (...args) => this.updateUsers(...args)
            await retry(fn, [slice])
        }
    }

    async collectAllUsers() {
        const currBlock = await this.web3.eth.getBlockNumber() - 10
        console.log({currBlock})
        for(let startBlock = this.deployBlock ; startBlock < currBlock ; startBlock += this.blockStepInInit) {
            console.log({startBlock}, this.userList.length, this.blockStepInInit)

            const endBlock = (startBlock + this.blockStepInInit > currBlock) ? currBlock : startBlock + this.blockStepInInit
            let events
            try {
                // Try to run this code
                events = await this.masterChef.getPastEvents("Deposit", {filter: {"pid": [this.pid]}, fromBlock: startBlock, toBlock:endBlock})
            }
            catch(err) {
                // if any error, Code throws the error
                console.log("call failed, trying again", err.toString())
                startBlock -= this.blockStepInInit // try again
                continue
            }
            for(const e of events) {
                //console.log("pid", e.returnValues.pid)
                const a = e.returnValues.user
                if(! this.userList.includes(a)) this.userList.push(a)
            }
        }
    }

    async updateAllUsers() {
        const users = this.userList //require('./my.json')
        const bulkSize = this.multicallSize
        for(let i = 0 ; i < users.length ; i+= bulkSize) {
            const start = i
            const end = i + bulkSize > users.length ? users.length : i + bulkSize
            console.log("update", i.toString() + " / " + users.length.toString())
            try {
                await this.updateUsers(users.slice(start, end))
            }
            catch(err) {
                console.log("update user failed, trying again", err)
                i -= bulkSize
            }
        }
    }

    async updateUsers(userAddresses) {
        // call user info
        const calls = []
        for(const user of userAddresses) {
            const call = {}
            call["target"] = this.masterChef.options.address
            call["callData"] = this.masterChef.methods.userInfo(this.pid, user).encodeABI()
            calls.push(call)            
        }

        console.log("get user info")
        const results = await this.multicall.methods.tryAggregate(false, calls).call()
        for(let i = 0 ; i < userAddresses.length ; i++) {
            const user = userAddresses[i]
            const result = results[i]

            const params = this.web3.eth.abi.decodeParameters(["uint256", "uint256"], result.returnData)
            const balance = params[0]

            this.users[user] = balance
        }
    }
  }

module.exports = MasterChef


async function test() {
    /*
    const wethNear = { "NEAR" : { "address" : Addresses.triNasterChefV1Address, "pid" : 0,
    "deployBlock" : 52661885, "blockStepInInit" : 500000 * 2, "multicallSize" : 200, "version" : 1}}

    const usdcNear = { "NEAR" : { "address" : Addresses.triNasterChefV2Address, "pid" : 25,
    "deployBlock" : 54579980, "blockStepInInit" : 500000 * 2, "multicallSize" : 200, "version" : 2}}
*/

    const pairs = [
        {"name" : "WETH-NEAR", "pid" : 0, "version" : 1},
        {"name" : "WBTC-NEAR", "pid" : 4, "version" : 1},                
        {"name" : "USDC-NEAR", "pid" : 25, "version" : 2},
        {"name" : "USDT-NEAR", "pid" : 26, "version" : 2}
    ]

    const web3 = new Web3("https://mainnet.aurora.dev")

    for(const pair of pairs) {
        const master = new MasterChef(pair.name,
                                      pair.pid,
                                      pair.version === 1 ? Addresses.triMasterChefV1Info : Addresses.triMasterChefV2Info,
                                      "NEAR",
                                      web3)
        master.main(false)    
    }
 }

 test()

