const Web3 = require('web3')
const { toBN, toWei, fromWei } = Web3.utils
const axios = require('axios')
const Addresses = require("./Addresses.js")
const fs = require('fs');

async function getTokaiLiquidity(web3, tokens) {
    const token0s = tokens
    const token1s = tokens

    const router = new web3.eth.Contract(Addresses.uniswapRouter02Abi, Addresses.yokaiswapAddress)
    const factoryAddress = await router.methods.factory().call()
    console.log({factoryAddress})
    const factory = new web3.eth.Contract(Addresses.uniswapFactoryAbi, factoryAddress)
    const multicall = new web3.eth.Contract(Addresses.multicallAbi, Addresses.multicallAddress)

    // reserves of each token pair
    const reserves = []
    const getReservesCalls = []

    for(const token0 of token0s) {
        for(const token1 of token1s) {
            const call = {}
            call["target"] = factoryAddress
            call["callData"] = factory.methods.getPair(token0, token1).encodeABI()
            getReservesCalls.push(call)            
        }
    }

    console.log("do calls for get reserves")
    const reservesResults = await multicall.methods.tryAggregate(true, getReservesCalls).call()
    for(let i = 0 ; i < reservesResults.length ; i++) {
        if(! reservesResults[i].success) success = false
        const reserve = web3.eth.abi.decodeParameter("address", reservesResults[i].returnData)

        reserves.push(reserve)
    }

    const erc20 = new web3.eth.Contract(Addresses.erc20Abi)

    const balanceOfCalls = []
    let cntr = 0
    for(const token0 of token0s) {
        for(const token1 of token1s) {
            const call0 = {}
            const call1 = {}            
            call0["target"] = token0
            call1["target"] = token1
            call0["callData"] = call1["callData"] = erc20.methods.balanceOf(reserves[cntr++]).encodeABI()

            balanceOfCalls.push(call0)
            balanceOfCalls.push(call1)
        }
    }

    console.log("do calls for get balances")
    const balanceOfResults = await multicall.methods.tryAggregate(true, balanceOfCalls).call()
    cntr = 0
    const assignedReserves = []
    const output = {}
    for(const token0 of token0s) {
        for(const token1 of token1s) {
            const i = parseInt(cntr / 2)

            const token0Bal = web3.eth.abi.decodeParameter("uint256", balanceOfResults[cntr++].returnData)
            const token1Bal = web3.eth.abi.decodeParameter("uint256", balanceOfResults[cntr++].returnData)

            const reserve = reserves[i]

            if(reserve === "0x0000000000000000000000000000000000000000") continue

            output[token0.toString() + "_" + token1.toString()] =
                {"token0" : token0Bal.toString(), "token1" : token1Bal.toString(), "reserve": reserve.toString()}
        }
    }    

    return output
}

function calcDestQty(dx, x, y) {
    // (x + dx) * (y-dy) = xy
    // dy = y - xy/(x+dx)

    const z = toBN(x).mul(toBN(y)).div(toBN(x).add(toBN(dx)))

    return toBN(y).sub(z)
}

function arrayRemove(arr, value) { 
    return arr.filter(function(ele){ 
        return ele != value; 
    })
}


function findBestDestQty(srcToken, srcQty, destToken, allTokens, liquidityJson) {
    if(srcToken ===  destToken) return toBN(srcQty)
    if(allTokens.length === 0) return toBN(0)


    let bestDestQty = toBN("0")
    for(const token of allTokens) {
        const key = srcToken.toString() + "_" + token.toString()
        if(! liquidityJson[key]) continue

        const x = liquidityJson[key].token0
        const y = liquidityJson[key].token1

        const dy = calcDestQty(srcQty, x, y)

        const newSrcToken = token
        const newSrcQty = dy
        const newAllToken = arrayRemove(allTokens, token)

        const bestCandidate = findBestDestQty(newSrcToken, newSrcQty, destToken, newAllToken, liquidityJson)
        console.log(srcToken, key, bestCandidate.toString())
        if(bestCandidate.gt(bestDestQty)) bestDestQty = bestCandidate
    }

    return bestDestQty
}

const web3 = new Web3("https://v1.mainnet.godwoken.io/rpc")
const ETH = "0x9E858A7aAEDf9FDB1026Ab1f77f627be2791e98A"
const BNB = "0xBAdb9b25150Ee75bb794198658A4D0448e43E528"
const USDC = "0x186181e225dc1Ad85a4A94164232bD261e351C33"
const WCKB = "0xC296F806D15e97243A08334256C705bA5C5754CD"
const USDT = "0x8E019acb11C7d17c26D334901fA2ac41C1f44d50"
const BTC = "0x82455018F2c32943b3f12F4e59D0DA2FAf2257Ef"

const ALL = [ETH, BNB, USDC, WCKB, USDT, BTC]

async function test() {
    const liquidityJson = await getTokaiLiquidity(web3, ALL)
    console.log({liquidityJson})

    const ethPrice = findBestDestQty(ETH, toWei("1"), USDC, ALL, liquidityJson)

    console.log(ethPrice.toString(), {ETH}, {USDC})
}

test()
