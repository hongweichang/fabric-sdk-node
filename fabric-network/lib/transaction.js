/**
 * Copyright 2018 IBM All Rights Reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const logger = require('fabric-network/lib/logger').getLogger('Transaction');
const util = require('util');

const noOpTxEventHandler = {
	startListening: async () => {},
	waitForEvents: async () => {},
	cancelListening: () => {}
};

/**
 * Ensure supplied transaction arguments are not strings.
 * @private
 * @static
 * @param {Array} args transaction arguments.
 * @throws {Error} if any arguments are invalid.
 */
function verifyArguments(args) {
	const isInvalid = args.some((arg) => typeof arg !== 'string');
	if (isInvalid) {
		const argsString = args.map((arg) => util.format('%j', arg)).join(', ');
		const msg = util.format('Transaction arguments must be strings: %s', argsString);
		logger.error('verifyArguments:', msg);
		throw new Error(msg);
	}
}

/**
 * Represents a specific invocation of a transaction function, and provides
 * felxibility over how that transaction is invoked. Applications should
 * obtain instances of this class by calling
 * [Contract#createTransaction()]{@link module:fabric-network.Contract#createTransaction}.
 * <br><br>
 * Instances of this class are stateful. A new instance <strong>must</strong>
 * be created for each transaction invocation.
 * @memberof module:fabric-network
 * @hideconstructor
 */
class Transaction {
	/*
	 * @param {Contract} contract Contract to which this transaction belongs.
	 * @param {String} name Fully qualified transaction name.
	 */
	constructor(contract, name) {
		this._contract = contract;
		this._name = name;
		this._transactionId = contract.createTransactionID();
		this._transientMap = null;
		this._createTxEventHandler = (() => noOpTxEventHandler);
		this._isInvoked = false;
	}

	/**
	 * Get the fully qualified name of the transaction function.
	 * @returns {String} Transaction name.
	 */
	getName() {
		return this._name;
	}

	/**
	 * Get the ID that will be used for this transaction invocation.
	 * @returns {module:fabric-client.TransactionID} Transaction ID.
	 */
	getTransactionID() {
		return this._transactionId;
	}

	/**
	 * Set the event handler strategy to be used for this transaction invocation
	 * instead of the default handler configured in the gateway options.
	 * @private
	 * @param {Function} factoryFunction Event handler factory function.
	 * @returns {module:fabric-network.Transaction} This object, to allow function chaining.
	 */
	setEventHandlerStrategy(factoryFunction) {
		this._createTxEventHandler = factoryFunction;
		return this;
	}

	/**
	 * Set transient data that will be passed to the transaction function
	 * but will not be stored on the ledger. This can be used to pass
	 * private data to a transaction function.
	 * @param {Object} transientMap Object with String property names and
	 * Buffer property values.
	 * @returns {module:fabric-network.Transaction} This object, to allow function chaining.
	 */
	setTransient(transientMap) {
		this._transientMap = transientMap;
		return this;
	}

	/**
	 * Submit a transaction to the ledger. The transaction function <code>name</code>
	 * will be evaluated on the endorsing peers and then submitted to the ordering service
	 * for committing to the ledger.
	 * @async
     * @param {...String} [args] Transaction function arguments.
     * @returns {Buffer} Payload response from the transaction function.
     */
	async submit(...args) {
		verifyArguments(args);
		this._setInvokedOrThrow();

		const network = this._contract.getNetwork();
		const channel = network.getChannel();
		const txId = this._transactionId.getTransactionID();
		const eventHandler = this._createTxEventHandler(txId, network, this._contract.getEventHandlerOptions());

		const request = {
			chaincodeId: this._contract.getChaincodeId(),
			txId: this._transactionId,
			fcn: this._name,
			args: args
		};
		if (this._transientMap) {
			request.transientMap = this._transientMap;
		}

		// node sdk will target all peers on the channel that are endorsingPeer or do something special for a discovery environment
		const results = await channel.sendTransactionProposal(request);
		const proposalResponses = results[0];
		const proposal = results[1];

		// get only the valid responses to submit to the orderer
		const {validResponses} = this._validatePeerResponses(proposalResponses);

		await eventHandler.startListening();

		// Submit the endorsed transaction to the primary orderers.
		const response = await channel.sendTransaction({
			proposalResponses: validResponses,
			proposal
		});

		if (response.status !== 'SUCCESS') {
			const msg = util.format('Failed to send peer responses for transaction %j to orderer. Response status: %j', txId, response.status);
			logger.error('submit:', msg);
			eventHandler.cancelListening();
			throw new Error(msg);
		}

		await eventHandler.waitForEvents();

		return validResponses[0].response.payload || null;
	}

	_setInvokedOrThrow() {
		if (this._isInvoked) {
			throw new Error('Transaction has already been invoked');
		}
		this._isInvoked = true;
	}

	/**
     * Check for proposal response errors.
     * @private
     * @param {any} responses the responses from the install, instantiate or invoke
     * @return {Object} number of ignored errors and valid responses
     * @throws if there are no valid responses at all.
     */
	_validatePeerResponses(responses) {
		if (!responses.length) {
			logger.error('_validatePeerResponses: No results were returned from the request');
			throw new Error('No results were returned from the request');
		}

		const validResponses = [];
		const invalidResponses = [];
		const invalidResponseMsgs = [];

		responses.forEach((responseContent) => {
			if (responseContent instanceof Error) {
				// this is either an error from the sdk, peer response or chaincode response.
				// we can distinguish between sdk vs peer/chaincode by the isProposalResponse flag in the future.
				// TODO: would be handy to know which peer the response is from and include it here.
				const message = responseContent.message;
				logger.warn('_validatePeerResponses: Received error response from peer:', responseContent);
				logger.debug('_validatePeerResponses: invalid response from peer %j', responseContent.peer);
				invalidResponseMsgs.push(message);
				invalidResponses.push(responseContent);
			} else {
				// anything else is a successful response ie status will be less then 400.
				// in the future we can do things like verifyProposalResponse and compareProposalResponseResults
				// as part of an extended client side validation strategy but for now don't perform any client
				// side checks as the peers will have to do this anyway and it impacts client performance
				logger.debug('_validatePeerResponses: valid response from peer %j', responseContent.peer);
				validResponses.push(responseContent);
			}
		});

		if (validResponses.length === 0) {
			const messages = Array.of(`No valid responses from any peers. ${invalidResponseMsgs.length} peer error responses:`,
				...invalidResponseMsgs);
			const msg = messages.join('\n    ');
			logger.error('_validatePeerResponses: ' + msg);
			throw new Error(msg);
		}

		return {validResponses, invalidResponses};
	}

	/**
	 * Evaluate a transaction function and return its results.
	 * The transaction function will be evaluated on the endorsing peers but
	 * the responses will not be sent to the ordering service and hence will
	 * not be committed to the ledger.
	 * This is used for querying the world state.
	 * @async
     * @param {...String} [args] Transaction function arguments.
     * @returns {Buffer} Payload response from the transaction function.
     */
	async evaluate(...args) {
		verifyArguments(args);
		this._setInvokedOrThrow();

		const queryHandler = this._contract.getQueryHandler();
		const chaincodeId = this._contract.getChaincodeId();
		return queryHandler.queryChaincode(chaincodeId, this._transactionId, this._name, args, this._transientMap);
	}
}

module.exports = Transaction;
