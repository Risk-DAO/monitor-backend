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

class Compound {
    constructor(compoundInfo, network, web3, heavyUpdateInterval = 24) {
      this.web3 = web3
      this.network = network
      this.comptroller = new web3.eth.Contract(Addresses.comptrollerAbi, compoundInfo[network].comptroller)

      this.cETHAddresses = [compoundInfo[network].cETH]

      this.priceOracle = new web3.eth.Contract(Addresses.oneInchOracleAbi, Addresses.oneInchOracleAddress[network])
      this.multicall = new web3.eth.Contract(Addresses.multicallAbi, Addresses.multicallAddress[network])
      this.deployBlock = compoundInfo[network].deployBlock
      this.blockStepInInit = compoundInfo[network].blockStepInInit
      this.multicallSize = compoundInfo[network].multicallSize

      this.userList = []

      this.sumOfBadDebt = web3.utils.toBN("0")
      this.lastUpdateBlock = 0

      this.mainCntr = 0
      this.heavyUpdateInterval = heavyUpdateInterval

      this.tvl = toBN("0")
      this.totalBorrows = toBN("0")

      this.output = {}

      this.collateralFactors = {}
      this.borrowCaps = {}
      this.collateralCaps = {}
      this.names = {}
      this.liquidationIncentive = 0.0
      this.lastUpdateTime = 0
      this.users = {}
      this.prices = {}
      this.markets = []
      this.decimals = {}
      this.underlying = {}
      this.closeFactor = 0.0
    }

    getData() {
        const result =
        {
            "markets" : JSON.stringify(this.markets),
            "prices" : JSON.stringify(this.prices),
            "lastUpdateTime" : this.lastUpdateTime,
            "liquidationIncentive" : this.liquidationIncentive,
            "collateralFactors" : JSON.stringify(this.collateralFactors),
            "names" : JSON.stringify(this.names),
            "borrowCaps" : JSON.stringify(this.borrowCaps),
            "collateralCaps" : JSON.stringify(this.collateralCaps),
            "decimals" : JSON.stringify(this.decimals),
            "underlying" : JSON.stringify(this.underlying),
            "closeFactor" : JSON.stringify(this.closeFactor),            
            "users" : JSON.stringify(this.users)
        }   
        try {
            fs.writeFileSync("data.json", JSON.stringify(result));
        } catch (err) {
            console.error(err);
        } 

        return JSON.stringify(result)
    }

    async heavyUpdate() {
        const currBlock = await this.web3.eth.getBlockNumber() - 10
        const currTime = (await this.web3.eth.getBlock(currBlock)).timestamp        

        if(this.userList.length == 0) await this.collectAllUsers()
        await this.updateAllUsers()
    }

    async lightUpdate() {
        const currBlock = await this.web3.eth.getBlockNumber() - 10
        const currTime = (await this.web3.eth.getBlock(currBlock)).timestamp

        await this.periodicUpdateUsers(this.lastUpdateBlock)
        //await this.calcBadDebt(currTime) 
    }

    async main(onlyOnce = false) {
        try {
            await this.initPrices()
                        
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

    async getFallbackPrice(market) {
        const oracleAddress = await this.comptroller.methods.oracle().call()
        const oracleContract = new this.web3.eth.Contract(Addresses.compoundOracleAbi, oracleAddress)
    
        console.log("getFallbackPrice", oracleAddress, market)
        return await oracleContract.methods.getUnderlyingPrice(market).call()
    }

    async initPrices() {
        console.log("get markets")
        const markets = await this.comptroller.methods.getAllMarkets().call()

        for(const market of markets) {
            const marketData = await this.comptroller.methods.markets(market).call()
            const cf = marketData.collateralFactorMantissa
            const borrowCap = await this.comptroller.methods.borrowCaps(market).call()

            if(cf !== "0" || borrowCap !== "1") this.markets.push(market)
            else console.log("ignoring market ", market)
        }

        console.log(this.markets)

        let tvl = toBN("0")
        let totalBorrows = toBN("0")

        this.liquidationIncentive = fromWei(await this.comptroller.methods.liquidationIncentiveMantissa().call())

        for(const market of this.markets) {
            let price
            let balance
            let borrows
            console.log({market})

            const ctoken = new this.web3.eth.Contract(Addresses.cTokenAbi, market)
            console.log("getting market data")
            const marketData = await this.comptroller.methods.markets(market).call()
            const collateralFactor = marketData.collateralFactorMantissa

            this.closeFactor = fromWei(await this.comptroller.methods.closeFactorMantissa().call())

            this.collateralFactors[market] = fromWei(collateralFactor)
            console.log("getting market name start")
            this.names[market] = await ctoken.methods.name().call()

            /*
            const isPaused = await this.comptroller.methods.borrowGuardianPaused(market).call()
            const borrowCap = await this.comptroller.methods.borrowCaps(market).call() */

            console.log("getting market price")
            price = await this.getFallbackPrice(market)

            this.prices[market] = this.web3.utils.toBN(price)
            console.log(market, price.toString(), fromWei(collateralFactor), this.names[market])

            this.borrowCaps[market] = await this.comptroller.methods.borrowCaps(market).call()
            this.collateralCaps[market] = await this.comptroller.methods.mintCaps(market).call()

            console.log("getting market balance")

            if(this.cETHAddresses.includes(market)) {
                balance = await this.web3.eth.getBalance(market)
                this.decimals[market] = 18
                this.underlying[market] = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"
            }
            else {
                console.log("getting underlying")
                const underlying = await ctoken.methods.underlying().call()
                const token = new this.web3.eth.Contract(Addresses.cTokenAbi, underlying)
                balance = await token.methods.balanceOf(market).call()
                this.decimals[market] = Number(await token.methods.decimals().call())
                this.underlying[market] = underlying
            }            

            console.log("getting market borrows")            
            borrows = await ctoken.methods.totalBorrows().call()

            const _1e18 = toBN(toWei("1"))
            tvl = tvl.add(  (toBN(balance)).mul(toBN(price)).div(_1e18)  )
            totalBorrows = totalBorrows.add(  (toBN(borrows)).mul(toBN(price)).div(_1e18)  )
        }

        this.tvl = tvl
        this.totalBorrows = totalBorrows

        console.log("init prices: tvl ", fromWei(tvl.toString()), " total borrows ", fromWei(this.totalBorrows.toString()),
                "cf ", JSON.stringify(this.collateralFactors), "liquidation incentive ", this.liquidationIncentive)
    }


    async getPastEventsInSteps(cToken, key, from, to){
        let totalEvents = []
        for (let i = from; i < to; i = i + this.blockStepInInit) {
            const fromBlock = i
            const toBlock = i + this.blockStepInInit > to ? to : i + this.blockStepInInit
            const fn = (...args) => cToken.getPastEvents(...args)
            const events = await retry(fn, [key, {fromBlock, toBlock}])
            totalEvents = totalEvents.concat(events)
        }
        return totalEvents
    }

    async periodicUpdateUsers(lastUpdatedBlock) {
        const accountsToUpdate = []
        const currBlock = await this.web3.eth.getBlockNumber() - 10
        console.log({currBlock})

        const events = {"Mint" : ["minter"],
                        "Redeem" : ["redeemer"],
                        "Borrow" : ["borrower"],
                        "RepayBorrow" : ["borrower"],
                        "LiquidateBorrow" : ["liquidator","borrower"],
                        "Transfer" : ["from", "to"] }

        for(const market of this.markets) {
            const ctoken = new this.web3.eth.Contract(Addresses.cTokenAbi, market)
            const keys = Object.keys(events)
            console.log({keys})
            for (const key of keys) {
                const value = events[key]
                console.log({key}, {value})
                const newEvents = await this.getPastEventsInSteps(ctoken, key, lastUpdatedBlock, currBlock) 
                for(const e of newEvents) {
                    for(const field of value) {
                        console.log({field})
                        const a = e.returnValues[field]
                        console.log({a})
                        if(! accountsToUpdate.includes(a)) accountsToUpdate.push(a)
                    }
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
                events = await this.comptroller.getPastEvents("MarketEntered", {fromBlock: startBlock, toBlock:endBlock})
            }
            catch(err) {
                // if any error, Code throws the error
                console.log("call failed, trying again", err.toString())
                startBlock -= this.blockStepInInit // try again
                continue
            }
            for(const e of events) {
                const a = e.returnValues.account
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
        // need to get: 1) user in market 2) user collateral in all markets 3) user borrow balance in all markets
        
        // market in
        const assetInCalls = []
        console.log("preparing asset in calls")
        for(const user of userAddresses) {
            const call = {}
            call["target"] = this.comptroller.options.address
            call["callData"] = this.comptroller.methods.getAssetsIn(user).encodeABI()
            assetInCalls.push(call)
        }
        const assetInResult = await this.multicall.methods.tryAggregate(false, assetInCalls).call()

        const ctoken = new this.web3.eth.Contract(Addresses.cTokenAbi)
        
        // collateral balance
        const collateralBalanceCalls = []
        const borrowBalanceCalls = []
        for(const user of userAddresses) {
            for(const market of this.markets) {
                const collatCall = {}
                const borrowCall = {}
    
                collatCall["target"] = market
                borrowCall["target"] = market
                collatCall["callData"] = ctoken.methods.balanceOfUnderlying(user).encodeABI()
                borrowCall["callData"] = ctoken.methods.borrowBalanceCurrent(user).encodeABI()

                collateralBalanceCalls.push(collatCall)
                borrowBalanceCalls.push(borrowCall)
            }
        }

        console.log("getting collateral balances")
        const collateralBalaceResults = await this.multicall.methods.tryAggregate(false, collateralBalanceCalls).call()
        console.log("getting borrow balances")        
        const borrowBalanceResults = await this.multicall.methods.tryAggregate(false, borrowBalanceCalls).call()

        // init class for all users
        let userIndex = 0
        let globalIndex = 0
        for(const user of userAddresses) {
            let success = true
            if(! assetInResult[userIndex].success) success = false
            const assetsIn = this.web3.eth.abi.decodeParameter("address[]", assetInResult[userIndex].returnData)
            userIndex++

            const borrowBalances = {}
            const collateralBalances = {}
            for(const market of this.markets) {
                if(! collateralBalaceResults[globalIndex].success) success = false
                if(! borrowBalanceResults[globalIndex].success) success = false

                const colatBal = this.web3.eth.abi.decodeParameter("uint256", collateralBalaceResults[globalIndex].returnData)
                const borrowBal = this.web3.eth.abi.decodeParameter("uint256", borrowBalanceResults[globalIndex].returnData)

                borrowBalances[market] = this.web3.utils.toBN(borrowBal)
                collateralBalances[market] = this.web3.utils.toBN(colatBal)               

                globalIndex++
            }

            const userData = { "assets" : assetsIn, "borrowBalances" : borrowBalances, "collateralBalances" : collateralBalances,
                               "succ" : success}
            
            this.users[user] = userData
        }
    }
  }

module.exports = Compound


async function test() {
    const web3 = new Web3("https://mainnet.aurora.dev")
    const comp = new Compound(Addresses.aurigamiAddress, "NEAR", web3)
    await comp.main(true)
 }

 test()

