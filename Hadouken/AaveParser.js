const Web3 = require('web3')
const fs = require('fs');
const { toBN, toWei, fromWei } = Web3.utils
const Addresses = require("./Addresses.js");

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

class Aave {
    constructor(aaveInfo, network, web3, heavyUpdateInterval = 24) {
      this.web3 = web3
      this.network = network
      this.lendingPoolAddressesProvider = new web3.eth.Contract(Addresses.lendingPoolAddressesProviderAbi, aaveInfo[network].lendingPoolAddressesProviderAddress)
      this.aaveUserInfo = new web3.eth.Contract(Addresses.aaveUserInfoAbi, Addresses.aaveUserInfoAddress[network])

      this.multicall = new web3.eth.Contract(Addresses.multicallAbi, Addresses.multicallAddress[network])
      this.deployBlock = aaveInfo[network].deployBlock
      this.blockStepInInit = aaveInfo[network].blockStepInInit
      this.multicallSize = aaveInfo[network].multicallSize

      this.users = {}
      this.userList = []

      this.lastUpdateBlock = 0

      this.mainCntr = 0
      this.heavyUpdateInterval = heavyUpdateInterval

      this.output = {}


      this.markets = []
      this.names = {}
      this.decimals = {}
      this.lastUpdateTime = 0

      this.liquidationIncentive = {}
      this.collateralFactors = {}
      this.prices = {}
      this.underlying = {}
      this.closeFactor = {}
      this.borrowCaps = {}
      this.collateralCaps = {}
    }

    getData() {
        const result =
        {
            "markets" : JSON.stringify(this.markets),
            "prices" : JSON.stringify(this.prices),
            "lastUpdateTime" : this.lastUpdateTime,
            "liquidationIncentive" : JSON.stringify(this.liquidationIncentive),
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
            fs.writeFileSync(this.lendingPool.options.address + "_data.json", JSON.stringify(result));
        } catch (err) {
            console.error(err);
        } 

        return JSON.stringify(result)
    }    

    getBits(bigNum, startBit, endBit) {
        let output = 0
        for(let i = endBit; i >= startBit ; i--) {
            const divFactor = toBN("2").pow(toBN(i))
            const divNum = toBN(bigNum).div(divFactor)
            const roundDownDivNum = (divNum.div(toBN(2))).mul(toBN(2))
            //console.log(divNum.toString(), roundDownDivNum.toString())
            const bit = divNum.eq(roundDownDivNum) ? 0 : 1
            //console.log({bit})
            output = output * 2 + bit;
        }

        //console.log({output})

        return output
    }

    async initPrices() {
        const lendingPoolAddress = await this.lendingPoolAddressesProvider.methods.getLendingPool().call()
        this.lendingPool = new this.web3.eth.Contract(Addresses.lendingPoolAbi, lendingPoolAddress)

        const oracleAddress = await this.lendingPoolAddressesProvider.methods.getPriceOracle().call()
        this.oracle = new this.web3.eth.Contract(Addresses.aaveOracleAbi, oracleAddress)

        this.markets = await this.aaveUserInfo.methods.getReservesList(this.lendingPool.options.address).call()

        for(const market of this.markets) {
            const cfg = await this.lendingPool.methods.getConfiguration(market).call()
            const ltv = Number(this.getBits(cfg[0], 0, 15)) / 1e4
            const liquidationBonus = this.getBits(cfg[0], 32, 47) / 1e4

            this.liquidationIncentive[market] = liquidationBonus
            this.collateralFactors[market] = ltv

            const token = new this.web3.eth.Contract(Addresses.erc20Abi, market)
            const lastName = await token.methods.symbol().call()
            this.names[market] = lastName
            const tokenDecimals = await token.methods.decimals().call()
            this.decimals[market] = tokenDecimals

            console.log("calling market price", {market}, {lastName})
            const price = await this.oracle.methods.getAssetPrice(market).call()
            this.prices[market] = toBN(price).mul(toBN(10).pow(toBN(18 - Number(tokenDecimals))))
            console.log(price.toString())
            console.log("calling market price end")


            this.underlying[market] = market 
            this.closeFactor[market] = 0.5
            this.borrowCaps[market] = 0
            this.collateralCaps[market] = 0
        }        
    }

    async heavyUpdate() {
        if(this.userList.length == 0) await this.collectAllUsers()
        await this.updateAllUsers()
    }

    async lightUpdate() {        
        await this.periodicUpdateUsers(this.lastUpdateBlock)
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

        await this.getData()

        if(! onlyOnce) setTimeout(this.main.bind(this), 1000 * 60 * 60) // sleep for 1 hour
    }

    async getFallbackPrice(market) {
        return toBN("0") // todo - override in each market
    }

    async getPastEventsInSteps(contract, key, from, to){
        let totalEvents = []
        for (let i = from; i < to; i = i + this.blockStepInInit) {
            const fromBlock = i
            const toBlock = i + this.blockStepInInit > to ? to : i + this.blockStepInInit
            const fn = (...args) => contract.getPastEvents(...args)
            const events = await retry(fn, [key, {fromBlock, toBlock}])
            totalEvents = totalEvents.concat(events)
        }
        return totalEvents
    }

    async periodicUpdateUsers(lastUpdatedBlock) {
        const accountsToUpdate = []
        const currBlock = await this.web3.eth.getBlockNumber() - 10
        console.log({currBlock})

        // we ignore atokens transfer, and catch it when doing the all users update
        const events = {"Deposit" : ["onBehalfOf"],
                        "Withdraw" : ["user"],        
                        "Borrow" : ["onBehalfOf"],
                        "Repay" : ["user"],
                        "LiquidationCall" : ["user", "liquidator"]}

        const keys = Object.keys(events)
        console.log({keys})
        for (const key of keys) {
            const value = events[key]
            console.log({key}, {value})
            const newEvents = await this.getPastEventsInSteps(this.lendingPool, key, lastUpdatedBlock, currBlock) 
            for(const e of newEvents) {
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
        const currBlock = /*this.deployBlock + 5000 * 5 //*/ await this.web3.eth.getBlockNumber() - 10
        console.log({currBlock})
        for(let startBlock = this.deployBlock ; startBlock < currBlock ; startBlock += this.blockStepInInit) {
            console.log({startBlock}, this.userList.length, this.blockStepInInit)

            const endBlock = (startBlock + this.blockStepInInit > currBlock) ? currBlock : startBlock + this.blockStepInInit
            let events
            try {
                // Try to run this code
                events = await this.lendingPool.getPastEvents("Deposit", {fromBlock: startBlock, toBlock:endBlock})
            }
            catch(err) {
                // if any error, Code throws the error
                console.log("call failed, trying again", err.toString())
                startBlock -= this.blockStepInInit // try again
                continue
            }
            for(const e of events) {
                const a = e.returnValues.onBehalfOf
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

    async additionalCollateralBalance(userAddress) {
        return this.web3.utils.toBN("0")
    }

    async updateUsers(userAddresses) {
        // need to get: 1) getUserAccountData
        
        const getUserAccountCalls = []
        console.log("preparing getUserAccountCalls")
        for(const user of userAddresses) {
            const call = {}
            call["target"] = this.aaveUserInfo.options.address
            call["callData"] = this.aaveUserInfo.methods.getUserInfo(this.lendingPool.options.address, user).encodeABI()
            getUserAccountCalls.push(call)
            //console.log({call})
        
            console.log("doing a single call")
            const result = await this.aaveUserInfo.methods.getUserInfo(this.lendingPool.options.address, user).call()
            //console.log({result})

            const userObj = []
            const collaterals = {}
            const debts = {}
            for(let i = 0 ; i < result.assets.length ; i++) {
                collaterals[result.assets[i]] = toBN(result.collaterals[i])
                debts[result.assets[i]] = toBN(result.debts[i])
                //userObj.push({"asset" : result.assets[i], "collateral" : toBN(result.collaterals[i]), "debt" : toBN(result.debts[i])})
            }

            this.users[user] = {"asset": result.assets, "borrowBalances" : debts, "collateralBalances": collaterals,
                                "succ" : true}

            //this.users[user] = userObj            
        }



        // TODO - revive multicall
        return

        console.log("getting getUserAccountCalls")
        const getUserAccountResults = await this.multicall.methods.tryAggregate(false, getUserAccountCalls).call({gas:10e6})
        console.log("multicall ended")

        for(let i = 0 ; i < userAddresses.length ; i++) {
            const user = userAddresses[i]
            const result = getUserAccountResults[i]

            /*
            uint256 totalCollateralETH,
            uint256 totalDebtETH,
            uint256 availableBorrowsETH,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor*/

            const paramType = ["address[]", "uint256[]", "uint256[]"]
            const parsedResult = this.web3.eth.abi.decodeParameters(paramType,result.returnData)
            
            const assets = parsedResult["0"]
            const collateral = parsedResult["1"]
            const debt = parsedResult["2"]

            const userObj = []
            for(let i = 0 ; i < assets.length ; i++) {
                userObj.push({"asset" : assets[i], "collateral" : collateral[i].toString(), "debt" : debt.toString()})
            }

            this.users[user] = userObj
        }
    }
  }

module.exports = Aave

async function test() {
    const web3 = new Web3("https://godwoken-testnet-v1.ckbapp.dev")
    const aave = new Aave(Addresses.hadoukenAddress, "GW", web3)
    await aave.main(false)
 }

 test()