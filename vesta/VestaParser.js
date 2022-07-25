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

class Vesta {
    constructor(web3, network) {
      this.web3 = web3
      this.network = network

      this.multicall = new web3.eth.Contract(Addresses.multicallAbi, Addresses.multicallAddress[network])
      this.vestaParameters = new web3.eth.Contract(Addresses.vestaParametersAbi, Addresses.vestaParametersAddress)
      this.multiTroveGetter = new web3.eth.Contract(Addresses.multiTroveGetterAbi, Addresses.multiTroveGetterAddress)
      this.troveManager = new web3.eth.Contract(Addresses.troveManagerAbi, Addresses.vestaTroveManagerAddress)

      this.blockStepInInit = 3000
      this.multicallSize = 200

      this.lastUpdateBlock = 18543000

      this.userList = []
      this.assets = ["0x0000000000000000000000000000000000000000",
                     "0x8D9bA570D6cb60C7e3e0F31343Efe75AB8E65FB1",
                     "0xDBf31dF14B66535aF65AaC99C32e9eA844e14501",
                     "0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a",
                     "0x6C2C06790b3E3E3c38e12Ee22F8183b37a13EE55"]

      this.collateralFactors = {}
      this.borrowCaps = {}
      this.collateralCaps = {}
      this.names = {}
      this.liquidationIncentive = {}
      this.lastUpdateTime = 0
      this.users = {}
      this.prices = {}
      this.markets = []
      this.decimals = {}
      this.underlying = {}
      this.closeFactor = 0.0
    }

    async initPrices() {
        console.log("get price feed address")
        const priceFeedAddress = await this.vestaParameters.methods.priceFeed().call()
        this.priceFeed = new this.web3.eth.Contract(Addresses.priceFeedAbi, priceFeedAddress)

        for(const asset of this.assets) {
            const price = await this.priceFeed.methods.fetchPrice(asset).call()
            this.prices[asset] = toBN(price)
        }
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

            await this.collectAllUsers()

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

    async initPrices() {
        console.log("get price feed address")
        const priceFeedAddress = await this.vestaParameters.methods.priceFeed().call()
        this.priceFeed = new this.web3.eth.Contract(Addresses.priceFeedAbi, priceFeedAddress)

        for(const market of this.assets) {
            console.log({market})

            console.log("getting liquidation incentive")
            this.liquidationIncentive[market] = fromWei(await this.vestaParameters.methods.BonusToSP(market).call())

            console.log("getting MCR")
            const collateralFactor = await this.vestaParameters.methods.MCR(market).call()

            this.closeFactor = 1

            this.collateralFactors[market] = 1 / Number(fromWei(collateralFactor))

            console.log("getting market price")

            this.borrowCaps[market] = await this.vestaParameters.methods.vstMintCap(market).call()
            this.collateralCaps[market] = "0"

            console.log("getting market balance")

            if(market === "0x0000000000000000000000000000000000000000") {
                this.decimals[market] = 18
                this.underlying[market] = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"
                this.names[market] = "ETH"
            }
            else {
                console.log("getting underlying")
                const underlying = market
                const token = new this.web3.eth.Contract(Addresses.erc20Abi, underlying)
                this.decimals[market] = Number(await token.methods.decimals().call())
                this.underlying[market] = underlying
                console.log("getting market name start")
                this.names[market] = await token.methods.symbol().call()    
            }

            const price = await this.priceFeed.methods.fetchPrice(market).call()
            this.prices[market] = toBN(price).mul(toBN(10).pow(toBN(18 - Number(this.decimals[market]))))            

            console.log(market, price.toString(), fromWei(collateralFactor), this.names[market])
        }

        console.log("init prices: cf ", JSON.stringify(this.collateralFactors), "liquidation incentive ", this.liquidationIncentive)
    }

    async collectAllUsers() {
        const users = {}
        for(const market of this.assets) {
            const count = this.multicallSize
            for(let idx = 0 ; ; idx += count) {
                console.log("doing multi trove call")
                const results = await this.multiTroveGetter.methods.getMultipleSortedTroves(market, idx, count).call()
                console.log("multi trove call ended")                
                console.log(market, idx, results.length)
                const calls = []
                for(const result of results) {
                    const call = {}
                    call["target"] = this.troveManager.options.address
                    call["callData"] = this.troveManager.methods.Troves(result.owner, market).encodeABI()
                    calls.push(call)

                    /*
                    console.log("ori",{result})
                    const userKey = result.owner + "_" + market
                    users[userKey] = {"assets" : [market], "borrowBalances" : [toBN(result.debt)],
                                  "collateralBalances" : [toBN(result.coll)],
                                  "succ" : true}*/
                }

                console.log("doing mcall")
                const troveResults = await this.multicall.methods.tryAggregate(false, calls).call()
                console.log("mcall ended")                
                for(let i = 0 ; i < troveResults.length ; i++) {
                    const user = results[i].owner
                    const troveResult = troveResults[i]
                    /*
                    struct Trove {
                        address asset;
                        uint256 debt;
                        uint256 coll;
                        uint256 stake;
                        Status status;
                        uint128 arrayIndex;
                    }*/
                    const paramsType = ["address", "uint256", "uint256", "uint256", "uint256", "uint128"]
                    const params = this.web3.eth.abi.decodeParameters(paramsType, troveResult.returnData)
                    const debt = params[1]
                    const coll = params[2]
        
                    const userKey = user + "_" + market

                    users[userKey] = {"assets" : [market], "borrowBalances" : [toBN(debt)],
                                  "collateralBalances" : [toBN(coll)],
                                  "succ" : troveResult.succ}                    
                }

                if(results.length < count) break
            }
        }

        this.users = users
    }
  }

module.exports = Vesta


async function test() {
    const web3 = new Web3("https://rpc.ankr.com/arbitrum")
    const vesta = new Vesta(web3 ,"ARBITRUM")

    /*
    console.log("getting last block")
    const lastblock = await web3.eth.getBlockNumber() - 10
    console.log({lastblock})
    await vesta.collectAllUsers()
    await vesta.initPrices()
    vesta.getData()
    */
    await vesta.main(true)
 }

 test()

