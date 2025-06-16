// const DEGUG_MESSAGES_COUNTER_LIMIT = 10
// var DEBUG_START="off"
// var DEGUG_MESSAGES_COUNTER = 0
// var DEBUG_COUNTER = 0

type EmbedObject = {
    cast_id: {
        fid: number;
        hash: string;
    };
    cast: {
        object: string;
        hash: string;
        author: {
            object: string;
            fid: number;
            username: string;
            display_name: string;
            pfp_url: string;
        };
        thread_hash: string;
        parent_hash: string | null;
        parent_url: string;
        root_parent_url: string;
        parent_author: {
            fid: number | null;
        };
        text: string;
        timestamp: string;
        embeds: {
            url: string;
            metadata: {
                content_type: string;
                content_length: number | null;
                _status: string;
                html: {
                    favicon: string;
                    ogImage: { url: string }[];
                    ogTitle: string;
                    ogLocale: string;
                    ogDescription: string;
                };
            };
        }[];
        channel: {
            object: string;
            id: string;
            name: string;
            image_url: string;
            viewer_context: {
                following: boolean;
            };
        };
    };
};

// fetch conversation history last messages
interface ConversationMessage {
    object: string;
    hash: string;
    author: Author;
    text: string;
    timestamp: string;
}
interface Author {
    object: string;
    fid: number;
    username: string;
    display_name: string;
    pfp_url: string;
}
// fetch conversation history last messages


// User data 
// interface BOTUserData {
//     fid: number;
//     fName: string;
//     display_name?: string;
//     bio?: string;
//     city?: string;
//     state?: string;
//     country_code?: string;
//     follower_count?: number;
//     following_count?: number;
//     verifications?: number;
//     power_badge?: boolean;
//     viewer_context?: {
//         following: boolean;
//         followed_by: boolean;
//     };
// }
//

import { randomInt } from 'crypto';

import {
    HubEvent, HubEventType,
    OnChainEventType,
    Message,
    MessageType,
    HubAsyncResult,
    isUserDataAddMessage,
    UserDataType,
    CastType,
    ReactionType,
    UserNameType,
    fromFarcasterTime,
    Protocol,
    Embed,
} from '@farcaster/hub-nodejs'

// import { CastParamType, FeedType, FilterType, isApiErrorResponse } from "@neynar/nodejs-sdk";
import neynarClient from "./lib/neynarClient";
import neynarHubClient from "./lib/neynarClient";

import { err, ok, Result } from "neverthrow";
import { hubClient } from './lib/hub-client'
import { EventBus } from './eventBus.interface'

import { saveLatestEventId, getLatestEvent } from './api/event'
import * as botConfig from "./config";

import GraphemeSplitter from 'grapheme-splitter';
// import { console } from 'inspector';

import FileLogger from './lib/FileLogger'

import { VerificationProtocol, MessageBodyJson, BotCastObj, CastAddBodyJson, BotChatMessage } from './bot.types';
import { inspect } from 'node:util';
// import { BulkUsersResponse, CastWithInteractions, Conversation, UserResponse } from '@neynar/nodejs-sdk/build/neynar-api/v2';
import { workersSystem } from './workers';
import { UserResponse } from '@neynar/nodejs-sdk/build/api/models/user-response';
import { CastParamType, CastWithInteractions, FeedType, FilterType } from '@neynar/nodejs-sdk/build/api/models';
import { isApiErrorResponse } from '@neynar/nodejs-sdk/build';

// const urlMatchesTargetChannel = (url: string): boolean => botConfig.TARGET_CHANNELS.some(target => url.endsWith(target));

export class Farcaster {
    public MEM_USED: NodeJS.MemoryUsage;

    private eventBus: EventBus;

    private USERS_DATA_INFO: Map<string, UserResponse>;
    private USERS_FNAME_MAP: Map<number, any>;  // TODO: need to replace to user new USERS_DATA_INFO
    private TARGET_FNAME_MAP: Map<number, any>;

    private isConnected: boolean;
    private isReconnecting: boolean;
    private isStopped: boolean; // set by external discord command

    private farcasterLog: FileLogger;

    constructor(eventBus: EventBus) {
        this.MEM_USED = process.memoryUsage();

        this.eventBus = eventBus;
        this.USERS_DATA_INFO = new Map();
        this.USERS_FNAME_MAP = new Map();
        this.TARGET_FNAME_MAP = new Map();

        this.isConnected = false;
        this.isReconnecting = false;
        this.isStopped = false;
        this.farcasterLog = new FileLogger({ folder: './logs-farcaster-out', printconsole: true });
        // setTimeout(() => {this.subscriberStream();}, 2000);
    }

    private bytesToHex(value: Uint8Array): `0x${string}` {
        return `0x${Buffer.from(value).toString("hex")}`;
    }

    private hubProtocolToVerificationProtocol(protocol: Protocol): VerificationProtocol {
        switch (protocol) {
            case Protocol.ETHEREUM:
                return "ethereum";
            // case Protocol.SOLANA:
            //     return "solana";
        }
    }

    private protocolBytesToString(bytes: Uint8Array, protocol: Protocol | VerificationProtocol): string {
        switch (protocol) {
            case Protocol.ETHEREUM:
            case "ethereum":
                return this.bytesToHex(bytes);
            // case Protocol.SOLANA:
            //   case "solana":
            // return bytesToBase58(bytes)._unsafeUnwrap();
            default:
                throw new Error(`Unexpected protocol: ${protocol}`);
        }
    }

    private farcasterTimeToDate(time: number): Date;
    private farcasterTimeToDate(time: null): null;
    private farcasterTimeToDate(time: undefined): undefined;
    private farcasterTimeToDate(time: number | null | undefined): Date | null | undefined {
        if (time === undefined) return undefined;
        if (time === null) return null;
        const result = fromFarcasterTime(time);
        if (result.isErr()) throw result.error;
        return new Date(result.value);
    }

    async insertMentions(text: string, mentions: number[], mentionsPositions: number[]): Promise<string> {
        const splitter = new GraphemeSplitter();
        const graphemes = splitter.splitGraphemes(text);

        // Normalize positions by mapping each visual position to grapheme index
        const normalizedPositions = mentionsPositions.map((pos) =>
            splitter.splitGraphemes(text.slice(0, pos)).length
        );

        // Use the correct position from mentionsPositions
        for (let i = mentions.length - 1; i >= 0; i--) {
            const mention = mentions[i];
            const fName = await this.handleUserFid(mention);
            const position = mentionsPositions[i];
            graphemes.splice(position, 0, `@${fName}`);
        }
        return graphemes.join('');
    }

    private convertProtobufMessageBodyToJson(message: Message): MessageBodyJson {
        let body: MessageBodyJson;
        switch (message.data?.type) {
            case MessageType.CAST_ADD: {
                if (!message.data.castAddBody) {
                    console.error("Missing castAddBody");
                    return
                }
                const {
                    embeds: embedsFromCastAddBody,
                    mentions,
                    mentionsPositions,
                    text,
                    parentCastId,
                    parentUrl,
                    type,
                } = message.data.castAddBody;

                const embeds: string[] = [];

                for (const embed of embedsFromCastAddBody) {
                    if (typeof embed.castId !== "undefined") {
                        embeds.push(this.bytesToHex(embed.castId.hash));
                    }
                    // We are going "one of" approach on the embed Cast Id and URL.
                    // If both are set its likely a client attributing itself with the same
                    // cast information. If it is a different URL representing a different cast
                    // that would be inaccurate way to push data to the protocol anyway.
                    // Eventually we may want to attribute which client quoted cast was shared
                    // from - but that will require a data model change on how messages are stored.
                    else if (typeof embed.url !== "undefined") {
                        embeds.push(embed.url);
                    }
                }

                body = {
                    embeds: embeds,
                    mentions,
                    mentionsPositions,
                    text,
                    type,
                    parent: parentCastId ? {
                        fid: parentCastId.fid,
                        hash: this.bytesToHex(parentCastId.hash)
                    } : { fid: 0, hash: "0x0" },
                };
                break;
            }
            case MessageType.CAST_REMOVE: {
                if (!message.data.castRemoveBody) throw new Error("Missing castRemoveBody");
                const { targetHash } = message.data.castRemoveBody;
                body = { targetHash: this.bytesToHex(targetHash) };
                break;
            }
            case MessageType.REACTION_ADD:
            case MessageType.REACTION_REMOVE: {
                if (!message.data.reactionBody) throw new Error("Missing reactionBody");
                if (message.data.reactionBody.targetCastId) {
                    const {
                        type,
                        targetCastId: { fid, hash },
                    } = message.data.reactionBody;
                    body = { type, target: { fid, hash: this.bytesToHex(hash) } };
                } else if (message.data.reactionBody.targetUrl) {
                    const { type, targetUrl } = message.data.reactionBody;
                    body = { type, target: targetUrl };
                } else {
                    throw new Error("Missing targetCastId and targetUrl on reactionBody");
                }
                break;
            }
            case MessageType.LINK_ADD:
            case MessageType.LINK_REMOVE: {
                if (!message.data.linkBody) throw new Error("Missing linkBody");
                const target = message.data.linkBody.targetFid;
                if (!target) throw new Error("Missing linkBody target");
                const { type, targetFid, displayTimestamp } = message.data.linkBody;
                body = { type, targetFid };
                if (displayTimestamp) {
                    const displayTimestampUnixResult = fromFarcasterTime(displayTimestamp);
                    if (displayTimestampUnixResult.isErr()) throw displayTimestampUnixResult.error;
                    body.displayTimestamp = displayTimestampUnixResult.value;
                }
                break;
            }
            case MessageType.LINK_COMPACT_STATE: {
                if (!message.data.linkCompactStateBody) throw new Error("Missing linkCompactStateBody");
                const { type, targetFids } = message.data.linkCompactStateBody;
                body = { type, targetFids };
                break;
            }
            case MessageType.VERIFICATION_ADD_ETH_ADDRESS: {
                if (!message.data.verificationAddAddressBody) {
                    throw new Error("Missing verificationAddAddressBody");
                }
                const { address, claimSignature, blockHash, protocol } = message.data.verificationAddAddressBody;
                body = {
                    address: this.protocolBytesToString(address, protocol),
                    claimSignature: this.protocolBytesToString(claimSignature, protocol),
                    blockHash: this.protocolBytesToString(blockHash, protocol),
                    protocol: this.hubProtocolToVerificationProtocol(protocol),
                };
                break;
            }
            case MessageType.VERIFICATION_REMOVE: {
                if (!message.data.verificationRemoveBody) throw new Error("Missing verificationRemoveBody");
                const { address, protocol } = message.data.verificationRemoveBody;
                body = {
                    address: this.protocolBytesToString(address, protocol),
                    protocol: this.hubProtocolToVerificationProtocol(protocol),
                };
                break;
            }
            case MessageType.USER_DATA_ADD: {
                if (!message.data.userDataBody) throw new Error("Missing userDataBody");
                const { type, value } = message.data.userDataBody;
                body = { type, value };
                break;
            }
            case MessageType.USERNAME_PROOF: {
                if (!message.data.usernameProofBody) throw new Error("Missing usernameProofBody");
                const { timestamp, name, owner, signature, fid, type } = message.data.usernameProofBody;
                body = {
                    timestamp,
                    name: this.bytesToHex(name),
                    owner: this.bytesToHex(owner),
                    signature: this.bytesToHex(signature),
                    fid,
                    type,
                };
                break;
            }
            default:
                // TODO: Once we update types in upstream @farcaster/hub-nodejs, switch to this
                // assertUnreachable(message.data.type);
                throw new Error(`Unknown message type ${message.data?.type}`);
        }

        return body;
    }

    private async subscriberStream(fromEventId: number | undefined) {
        const result = await hubClient.subscribe({
            eventTypes: [
                HubEventType.MERGE_MESSAGE, HubEventType.PRUNE_MESSAGE,
                HubEventType.REVOKE_MESSAGE, HubEventType.MERGE_ON_CHAIN_EVENT,
            ],
            fromId: fromEventId,       // the last event we processed
        })


        if (result.isErr()) {
            console.error(result.error + '\nError starting stream');
            if (!this.isStopped)
                this.reconnect();
            return
        }

        this.isConnected = true;
        this.isReconnecting = false;

        result.match(
            (stream) => {
                console.log(`Subscribed to Farcaster Stream from: ${fromEventId ? `event ${fromEventId}` : 'HEAD'}`);
                // console.info(`Subscribed to Farcaster Stream: HEAD`)         //current event

                // Manually trigger the 'close' event for testing // Simulate close after 3 seconds

                // setTimeout(() => { console.log("Simulating stream end..."); stream.emit('end'); }, 10000);
                // setTimeout(() => { console.log("Simulating stream close..."); stream.emit('close'); stream.emit('close'); }, 10000);

                stream.on('data', async (e: HubEvent) => {
                    this.handleEvent(e)
                    saveLatestEventId(e.id)
                    //console.log(e.id)

                    // Manually trigger the 'close' event from command
                    if (this.isStopped) {
                        this.isConnected = false;
                        stream.destroy();
                    }
                    // this.eventBus.publish("LAST_EVENT_ID", e.id);
                })

                stream.on('end', async () => {
                    this.farcasterLog.log(`Hub stream ended`, "EVENTS")
                    // console.log(`Stream object details on END:`);
                    // this.logRelevantStreamDetails(stream);
                    // this.isConnected = false;
                })

                stream.on('close', async () => {
                    this.farcasterLog.log(`Hub stream closed`, "EVENTS")
                    // console.warn(`Hub stream closed`)
                    // console.log(`Stream object details on CLOSE:`);
                    // this.logRelevantStreamDetails(stream);
                    if (!this.isStopped) {
                        //if we did not received external command to stop, try to reconect
                        this.isConnected = false;
                        this.reconnect();
                    }
                })
            }, (e) => { console.error(e, 'Error streaming data.') })
    }


    private reconnect() {
        console.log(`Reconnect: ` + botConfig.HUB_RPC + " " + + getLatestEvent());
        if (!this.isConnected && !this.isReconnecting) {
            this.farcasterLog.log(`Reconnecting in 1 second...`, "EVENTS")
            this.isReconnecting = true;

            setTimeout(async () => {
                if ((!this.isConnected) && (!this.isStopped))
                    this.subscriberStream(await getLatestEvent());
            }, 2777); // 1-second delay
        }
    }


    private logRelevantStreamDetails(stream: any) {
        const keysOfInterest = ['error', 'statusCode', 'closed', 'destroyed', '_readableState', 'call'];
        const filteredDetails: Record<string, any> = {};

        keysOfInterest.forEach((key) => {
            if (key in stream) {
                filteredDetails[key] = stream[key];
            }
        });

        console.log(
            `Filtered stream details:`,
            inspect(filteredDetails, { depth: 2, colors: true })
        );
    }

    private async handleEvent(event: HubEvent) {
        switch (event.type) {
            case HubEventType.MERGE_MESSAGE: {
                const msg = event.mergeMessageBody!.message!
                const msgType = msg.data!.type

                switch (msgType) {
                    case MessageType.CAST_ADD: {
                        this.handleAddCasts([msg]);
                        break
                    }
                    case MessageType.CAST_REMOVE: {
                        // this.deleteCasts([msg]);
                        break
                    }
                    case MessageType.VERIFICATION_ADD_ETH_ADDRESS: {
                        // this.insertVerifications([msg]);
                        break
                    }
                    case MessageType.VERIFICATION_REMOVE: {
                        // this.deleteVerifications([msg]);
                        break
                    }
                    case MessageType.USER_DATA_ADD: {
                        // this.insertUserDatas([msg]);
                        break
                    }
                    case MessageType.REACTION_ADD: {
                        // await insertReactions([msg])
                        // this.insertReactions([msg]);
                        break
                    }
                    case MessageType.REACTION_REMOVE: {
                        // await deleteReactions([msg])
                        // this.deleteReactions([msg]);
                        break
                    }
                    case MessageType.LINK_ADD: {
                        // await insertLinks([msg])
                        // this.insertLinks([msg]);
                        break
                    }
                    case MessageType.LINK_REMOVE: {
                        // await deleteLinks([msg])
                        // this.deleteLinks([msg]);
                        break
                    }
                    default: {
                        // log.info('UNHANDLED MERGE_MESSAGE EVENT', event.id)
                        // console.info('UNHANDLED MERGE_MESSAGE EVENT', event.id)
                        // this.eventBus.publish("LOG", 'UNHANDLED MERGE_MESSAGE EVENT: ' + event.id);
                    }
                }

                break
            }
            case HubEventType.PRUNE_MESSAGE: {
                const msg = event.pruneMessageBody!.message!
                const msgType = msg.data!.type

                switch (msgType) {
                    case MessageType.CAST_ADD: {
                        // await pruneCasts([msg])
                        break
                    }
                    case MessageType.REACTION_ADD: {
                        // await pruneReactions([msg])
                        break
                    }
                    case MessageType.LINK_ADD: {
                        // await pruneLinks([msg])
                        break
                    }
                    default: {
                        // this.eventBus.publish("LOG", 'UNHANDLED PRUNE_MESSAGE EVENT ' + msg.data);
                    }
                }

                break
            }
            case HubEventType.REVOKE_MESSAGE: {
                // Events are emitted when a signer that was used to create a message is removed
                // TODO: handle revoking messages
                break
            }
            case HubEventType.MERGE_ON_CHAIN_EVENT: {
                const onChainEvent = event.mergeOnChainEventBody!.onChainEvent!

                switch (onChainEvent.type) {
                    case OnChainEventType.EVENT_TYPE_ID_REGISTER: {
                        // await insertRegistrations([onChainEvent])
                        break
                    }
                    case OnChainEventType.EVENT_TYPE_SIGNER: {
                        // await insertSigners([onChainEvent])
                        break
                    }
                    case OnChainEventType.EVENT_TYPE_STORAGE_RENT: {
                        // await insertStorage([onChainEvent])
                        break
                    }
                }

                break
            }
            default: {
                console.log('UNHANDLED HUB EVENT', event.id)
                break
            }
        }
        // await job.updateProgress(100)
    }

    public async getTrendingFeed(filter = FilterType.GlobalTrending) {
        let trendingFeed = "";
        try {
            const feed = await neynarClient.fetchFeed({
                feedType: FeedType.Filter,
                filterType: filter,
            });
            for (const cast of Object.values(feed.casts))
                trendingFeed += `${cast.author.display_name}: ${cast.text}`;
        } catch (err) {
            console.error("Error fetching Farcaster Feed", err);
        }
        return trendingFeed;
    }



    /**
     * Function to publish a message (cast) using neynarClient.
     * @param msg - The message to be published.
     * @returns A promise that resolves when the operation completes.
     * Example of `response_data`:
        {
            hash: '0xbb89163dc43e88f05ff2e1fb0dbb8b781ddf547c',
            author: {
                object: 'user',
                fid: 527313,
                username: 'nounspacetom',
                display_name: 'nounspaceTom.eth',
                pfp_url: 'https://imagedelivery.net/BXluQx4ige9GuW0Ia56BHw/46134281-9cbd-431e-01cc-d128c7695700/original',
                custody_address: '0xaa3ea790b0d714dcab0bdb7a02a336393dd2e2d9',
                profile: { bio: [Object] },
                follower_count: 8377,
                following_count: 1258,
                verifications: [ '0x06ae622bf2029db79bdebd38f723f1f33f95f6c5' ],
                verified_addresses: { eth_addresses: [Array], sol_addresses: [] },
                verified_accounts: null,
                power_badge: true
            },
            text: "Here's to new beginnings! I'm thrilled to join this vibrant community, eager to learn..."
        }
     */
    private async publishToFarcaster(msg: string, options: any) {
        if (this.isStopped) return

        if (botConfig.LOG_MESSAGES) {
            let logid = "publishToFarcaster";
            if (!botConfig.PUBLISH_TO_FARCASTER)
                this.farcasterLog.log("PUBLISH_TO_FARCASTER OFF", logid)
            this.farcasterLog.log(`message:\n${msg}`, logid);
            // this.farcasterLog.log(`options:`, logid);
            // this.farcasterLog.log(options, logid);
        }

        if (!botConfig.PUBLISH_TO_FARCASTER) {
            this.farcasterLog.log("PUBLISH_TO_FARCASTER OFF", "INFO")
            return
        }

        neynarClient
            .publishCast({
                signerUuid: botConfig.SIGNER_UUID,
                text: msg,
                channelId: options.channelId,
                parentAuthorFid: options.parent_author_fid,
                parent: options.replyTo,
            })
            .then(response_data => {
                this.farcasterLog.log(`Cast published successfully:\n  https://warpcast.com/${botConfig.BotName}/${response_data.cast.hash}`, "INFO")
            })
            .catch(error => {
                if (isApiErrorResponse(error)) {
                    const errorCastObj = {
                        error: error.response.data,
                        msg,
                        options
                    }
                    // this.eventBus.publish("ERROR_FC_PUBLISH", errorCastObj);

                    this.farcasterLog.log("Failed to publish cast: " + error.response.data, "ERROR")
                    this.farcasterLog.log(msg, "ERROR")
                    this.farcasterLog.log(options, "ERROR")
                } else {
                    const errorCastObj = {
                        error: JSON.stringify(error),
                        msg,
                        options
                    }
                    // this.eventBus.publish("ERROR_FC_PUBLISH", errorCastObj);

                    this.farcasterLog.log("Failed to publish cast: " + JSON.stringify(error), "ERROR")
                    this.farcasterLog.log(msg, "ERROR")
                    this.farcasterLog.log(options, "ERROR")
                }
            });



        this.likeCast(options);
        // if ((options.replyTo) && (options.parent_author_fid)) {
        //     neynarClient.publishReaction({
        //         signerUuid: botConfig.SIGNER_UUID,
        //         reactionType: 'like',
        //         target: options.replyTo,
        //         targetAuthorFid: options.parent_author_fid
        //     }).then(response => {
        //         this.farcasterLog.log("Reaction published successfully ", "INFO")
        //         // console.log('Publish Reaction Operation Status:', response); // Outputs the status of the reaction post
        //     }).catch(error => {
        //         if (isApiErrorResponse(error)) {
        //             // console.error(Red + error.response.data + Reset);
        //             this.farcasterLog.log("Failed to publish reaction: " + error.response.data, "ERROR")
        //         } else {
        //             this.farcasterLog.log("Failed to publish reaction: " + JSON.stringify(error), "ERROR")
        //             // console.error(Red + "Failed to publish Reaction: " + error + + Reset);
        //         }
        //     });
        // }
    }

    public async delayedLikeCast(options:any){
        const delayInMinutes = randomInt(1, 2);
        setTimeout(() => {
            this.likeCast(options);
        }, delayInMinutes * 60 * 1000); // convert minutes to milliseconds
    }

    public async likeCast(options: any) {
        if ((options.replyTo) && (options.parent_author_fid)) {
            neynarClient.publishReaction({
                signerUuid: botConfig.SIGNER_UUID,
                reactionType: 'like',
                target: options.replyTo,
                targetAuthorFid: options.parent_author_fid
            }).then(response => {
                this.farcasterLog.log("Reaction published successfully ", "INFO")
                // console.log('Publish Reaction Operation Status:', response); // Outputs the status of the reaction post
            }).catch(error => {
                if (isApiErrorResponse(error)) {
                    // console.error(Red + error.response.data + Reset);
                    this.farcasterLog.log("Failed to publish reaction: " + error.response.data, "ERROR")
                } else {
                    this.farcasterLog.log("Failed to publish reaction: " + JSON.stringify(error), "ERROR")
                    // console.error(Red + "Failed to publish Reaction: " + error + + Reset);
                }
            });
        }
    }

    public async schedulePublishUserReply(msg: string, parentHash: string, parentAuthorFid: number) {
        // Using the neynarClient to publish the cast.
        const options = {
            replyTo: parentHash,
            parent_author_fid: parentAuthorFid,
        }

        // Wait for a random time between 1 and 2 minutes before publishing
        const delayInMinutes = randomInt(1, 2);
        setTimeout(() => {
            this.publishToFarcaster(msg, options);
        }, delayInMinutes * 60 * 1000); // convert minutes to milliseconds

        const fName = (await this.handleUserFid(parentAuthorFid));
        if (botConfig.PUBLISH_TO_FARCASTER)
            console.log(`Scheduling reply to FID ${parentAuthorFid} '${fName}' in ${delayInMinutes} minutes`);
    }

    public async publishUserReply(msg: string, parentHash: string, parentAuthorFid: number) {
        // Using the neynarClient to publish the cast.
        const options = {
            replyTo: parentHash,
            parent_author_fid: parentAuthorFid,
        }

        this.publishToFarcaster(msg, options);

        const fName = (await this.handleUserFid(parentAuthorFid));
        if (botConfig.PUBLISH_TO_FARCASTER)
            console.log(`Published Reply to:\n  https://warpcast.com/${fName}/${parentHash}`);
    }

    public async publishNewChannelCast(msg: string) {
        // Using the neynarClient to publish the cast.
        const options = {
            channelId: botConfig.CAST_TO_CHANNEL
        }

        this.publishToFarcaster(msg, options);
    };

    private async handleAddCasts(msgs: Message[]): Promise<void> {
        for (let m = 0; m < msgs.length; m++) {
            const data = msgs[m].data;
            if (data.castAddBody) {

                if (botConfig.TARGETS.includes(data.fid)) {
                    // Target Add New Cast

                    //TODO: retro alimentar issue

                    this.handleTargetAddCast(msgs[m])
                    return;
                }

                // if (data.castAddBody.parentCastId && botConfig.TARGETS.includes(data.castAddBody.parentCastId.fid)) {
                if ((data.castAddBody.parentCastId)
                    && (botConfig.BotFID == data.castAddBody.parentCastId.fid)) {
                    // Target found on parentCastId (Reply)
                    this.handleReceivedReply(msgs[m]);
                    return;
                }

                // const foundMention = data.castAddBody.mentions.find(mention => botConfig.TARGETS.includes(mention));
                const foundMention = data.castAddBody.mentions.find(mention => botConfig.BotFID == mention);
                if (foundMention) {
                    // Target found on Mention
                    this.handleMentioned(msgs[m], foundMention);
                    return;
                }

                // if (data.castAddBody.parentUrl && urlMatchesTargetChannel(data.castAddBody.parentUrl)) {
                //     // parentUrl Matches Channel
                //     this.handleTargetChannelCast(msgs[m]);
                //     return;
                // }

                if (data.castAddBody.embeds && data.castAddBody.embeds.find(embeds => botConfig.BotFID == embeds.castId?.fid)) {
                    this.handleQuoteCasts(msgs[m])
                    return;
                }

                this.debugMessage(msgs[m]);
            }
        }
    }


    private async debugMessage(message: Message) {
        if (botConfig.ENV !== "development")
            return;

        // DEBUG (optional logging block)
        // console.dir(message)
        // this.isStopped = true;
        // this.handleMentioned(message, botConfig.BotFID);
        return;

        // ragSystem.waitForDocumentsToLoad().then(() => {
        //     if (DEBUG_START == "wait_docs") {
        //         DEBUG_COUNTER = DEGUG_MESSAGES_COUNTER_LIMIT
        //         DEBUG_START = "started"
        //     }
        // });

        //     if (DEGUG_MESSAGES_COUNTER < DEBUG_COUNTER) {
        //         if (msgs[m].data.castAddBody.parentCastId) {
        //             if (msgs[m].data.castAddBody.parentCastId?.hash) {
        //                 // if (msgs[m].data.castAddBody.embeds.length > 0) {
        //                 // console.log(msgs[m].data.castAddBody.embeds[0].url);
        //                 // if (msgs[m].data.castAddBody.embeds[0].url && msgs[m].data.castAddBody.embeds[0].url.includes("image")) {
        //                 this.handleReceivedReply(msgs[m]);
        //                 //    console.log("New Cast to " + data.castAddBody.parentUrl);
        //                 //    console.log(formatCasts(msgs));
        //                 DEGUG_MESSAGES_COUNTER++
        //                 console.log("DEGUG_MESSAGES_COUNTER", DEGUG_MESSAGES_COUNTER)
        //             }
        //         }
        //         //}
        //         // }
        //     }
        // })
    }

    // working async with createCastObj to create cache for latter...
    // ... fetch and save into cache. return fetched data
    public async handleUserInfo(fname: string): Promise<UserResponse> {
        // check if fid is on the users fname cache
        if (!this.USERS_DATA_INFO.has(fname)) {
            this.getUserDataFromFname(fname).then((result) => {
                if (result) {
                    this.USERS_DATA_INFO.set(fname, result);
                }
            })
        }

        // trim max user fname cache
        if (this.USERS_DATA_INFO.size >= botConfig.MAX_USER_CACHE) {
            this.USERS_DATA_INFO.delete(this.USERS_DATA_INFO.keys().next().value as string);
        }

        return this.USERS_DATA_INFO.get(fname)//!;
    }

    private async handleUserFid(fid: number): Promise<string> {
        // check if fid is on the users fname cache
        if (!this.USERS_FNAME_MAP.has(fid)) {
            const result = await this.getFnameFromFid(fid);
            if (result.isOk()) {
                this.USERS_FNAME_MAP.set(fid, result.value);
            }
        }

        // trim max user fname cache
        if (this.USERS_FNAME_MAP.size >= botConfig.MAX_USER_CACHE) {
            this.USERS_FNAME_MAP.delete(this.USERS_FNAME_MAP.keys().next().value as number);
        }

        return this.USERS_FNAME_MAP.get(fid)!;
    }

    // get fname from fid using FC hub results.... we can replace this for new USER DATA INFO map
    private async getFnameFromFid(fid: number): HubAsyncResult<string> {
        const result = await hubClient.getUserData({ fid: fid, userDataType: UserDataType.USERNAME });
        // console.log(result, "UserData");
        return ok(
            result.match(
                (message) => {
                    if (isUserDataAddMessage(message)) {
                        return message.data.userDataBody.value;
                    } else {
                        return "";
                    }
                },
                () => `${fid}!`, // fallback to FID if no username is set
            ),
        );
    };

    // get some information from user using neynar
    private async getUserDataFromFname(fname: string): Promise<UserResponse> {
        try {
            const userData = await neynarClient
                .lookupUserByUsername({
                    username: fname,
                    viewerFid: botConfig.BotFID
                })
            // .fetchBulkUsers([fid], { viewerFid: botConfig.BotFID });
            // const userData = result; //select first result
            // this.farcasterLog.log(userData, "UserData");
            return userData;
            // return userData;
            // return {
            //     fid,
            //     fName: userData?.username,
            //     display_name: userData?.display_name,
            //     bio: userData?.profile?.bio?.text,
            //     city: userData?.profile?.location?.address?.city ?? 'Unknown',
            //     state: userData?.profile?.location?.address?.state ?? null,
            //     country_code: userData?.profile?.location?.address?.country_code ?? '',
            //     follower_count: userData?.follower_count ?? 0,
            //     following_count: userData?.following_count ?? 0,
            //     verifications: (userData?.verifications ?? []).length,
            //     power_badge: userData?.power_badge ?? false,
            //     viewer_context: {
            //       following: userData?.viewer_context?.following ?? false,
            //       followed_by: userData?.viewer_context?.followed_by ?? false,
            //     },
            // };
        }
        catch (err) {
            // console.error(err)
        };
    }

    // return bot targets from fid and store it on cache
    private async handleTargetFid(fid: number): Promise<string> {
        if (!this.TARGET_FNAME_MAP.has(fid)) {
            const result = await this.getFnameFromFid(fid);
            if (result.isOk()) {
                this.TARGET_FNAME_MAP.set(fid, result.value);
            }
        }

        return this.TARGET_FNAME_MAP.get(fid)!;
    }


    // handle when bot targest posst new message
    private async handleTargetAddCast(message: Message) {
        // const body = this.convertProtobufMessageBodyToJson(message);
        const tName = await this.handleTargetFid(message.data.fid);  // target Name
        const castObj = await this.createCastObj(message);
        this.eventBus.publish("CAST_ADD", castObj);

        // // if has parentCastId, its a new reply message
        // if (message.data.castAddBody.parentCastId) {
        //     const fName = await this.handleUserFid(message.data.castAddBody.parentCastId.fid); // farcaster (User)Name 
        //     // console.log(tName + " Replying to " + fName);
        //     const chatmessage = {
        //         name: tName,
        //         message: " Reply to " + fName + ": " + message.data.castAddBody.text
        //     }
        //     // this.eventBus.publish("CAST_ADD", chatmessage);
        // } else {
        //     // console.log(tName + " Add New Cast ");
        //     const chatmessage = {
        //         name: tName,
        //         message: message.data.castAddBody.text
        //     }
        //     // this.eventBus.publish("CAST_ADD", chatmessage);
        // }
    }

    private async handleQuoteCasts(message: Message): Promise<void> {
        // const tName = await this.handleTargetFid(message.data.castAddBody.parentCastId.fid);  // farcaster (User)Name 
        const castObj = await this.createCastObj(message);
        // console.dir(castObj);
        this.eventBus.publish("WAS_QUOTE_CAST", castObj);
    }

    private async handleReceivedReply(message: Message): Promise<void> {
        const tName = await this.handleTargetFid(message.data.castAddBody.parentCastId.fid);  // farcaster (User)Name 
        const castObj = await this.createCastObj(message);
        // console.dir(castObj);
        this.eventBus.publish("WAS_REPLIED", castObj);
    }

    private async handleMentioned(message: Message, foundMention: number): Promise<void> {
        const tName = await this.handleTargetFid(foundMention);  // target Name
        const castObj = await this.createCastObj(message);
        // console.log(tName + " was mentioned by " + castObj.fName);
        // console.dir(castObj);
        this.eventBus.publish("WAS_MENTIONED", castObj);
    }


    private async handleTargetChannelCast(message: Message) {
        if (message.data.castAddBody.parentUrl) {
            // console.warn("New Message at Channel: " + message.data.castAddBody.parentUrl);
            const castObj = await this.createCastObj(message);
            // console.dir(castObj);
            // generateTomReplyMemory(data.fid, data.castAddBody.text);
            this.eventBus.publish("CHANNEL_NEW_MESSAGE", castObj);
        }
    }


    private async createCastObj(message: Message): Promise<BotCastObj> {
        const body = this.convertProtobufMessageBodyToJson(message) as CastAddBodyJson;
        const fName = await this.handleUserFid(message.data.fid);        // farcast (User)Name 

        // get async user info so we can use latter if needed. maybe need to wait here if 
        // is a must has the user info for replies... 
        await this.handleUserInfo(fName);        // go fetch user info async

        const hash = this.bytesToHex(message.hash);

        if ('text' in body && 'mentions' in body && 'mentionsPositions' in body) {
            if (body.mentions instanceof Array && body.mentionsPositions instanceof Array) {

                let textContent = body.text;
                if (body.mentions.length > 0)
                    textContent = await this.insertMentions(body.text, body.mentions, body.mentionsPositions);
                body.textWithMentions = textContent;
            }
        }

        return {
            fid: message.data.fid,
            fName,
            hash,
            type: message.data.type,
            timestamp: this.farcasterTimeToDate(message.data.timestamp),
            body
        }
    }

    public stop() {
        try {
            this.isStopped = true;
            return true;
        } catch {
            return false;
        }
    }

    public async start(from: string) {
        try {
            this.isStopped = false;
            if (from == "head") {
                this.subscriberStream(undefined);
            } else {
                const lastid = await getLatestEvent();
                this.subscriberStream(lastid);
            }
            return true;
        } catch {
            return false;
        }
    }

    public getConnectionStatus() {
        return this.isConnected;
    }

    public async getQuoteCastContext(castHashOrUrl: string, castParamType: CastParamType = CastParamType.Hash): Promise<BotChatMessage[]> {
        var lastMessages: BotChatMessage[] = [];
        try {
            const response = await neynarClient.lookupCastConversation({
                identifier: castHashOrUrl,
                type: castParamType,
                replyDepth: 2,
                includeChronologicalParentCasts: true,
                viewerFid: botConfig.BotFID,
                limit: botConfig.LAST_CONVERSATION_LIMIT
                //                 limit: 10,
                // cursor: "nextPageCursor" // Omit this parameter for the initial request
            });

            lastMessages.push({
                name: response.conversation.cast.author.username,
                message: response.conversation.cast.text,
                imageUrl: "",
            });

            return lastMessages;
        }
        catch (error) {
            console.log('Get Quote Cast Context Fail:');
            return lastMessages;
        };
    }

    public async getConversationHistory(castHashOrUrl: string, castParamType: CastParamType = CastParamType.Hash): Promise<BotChatMessage[]> {
        var lastMessages: BotChatMessage[] = [];
        try {
            const response = await neynarClient.lookupCastConversation({
                identifier: castHashOrUrl,
                type: castParamType,
                replyDepth: 2,
                includeChronologicalParentCasts: true,
                viewerFid: botConfig.BotFID,
                limit: botConfig.LAST_CONVERSATION_LIMIT
                //limit: 10,
                //cursor: "nextPageCursor" // Omit this parameter for the initial request
            })

            const messages: CastWithInteractions[] = response.conversation.chronological_parent_casts.slice().reverse();
            const lastThreeMessages: BotChatMessage[] = messages
                .slice(0, botConfig.LAST_CONVERSATION_LIMIT)
                .reverse()
                .map((message: CastWithInteractions) => {
                    let imageUrl = "";
                    const embed = message.embeds[0];
                    if (typeof embed === 'object' && 'url' in embed) {
                        imageUrl = embed.url;
                    }
                    return { name: message.author.username, message: message.text, imageUrl };
                    // return `@${message.author.username}: ${message.text}\n`;

                });

            // Add Embbeded Cast to conversation history if exist
            if (response.conversation.cast.embeds.length > 0) {
                const embbedCast = response.conversation.cast.embeds[0] as unknown as EmbedObject | undefined;
                if (embbedCast.cast && embbedCast.cast.object &&
                    embbedCast.cast.object === 'cast_embedded' &&
                    embbedCast.cast.text
                ) {
                    lastThreeMessages.push({
                        name: embbedCast.cast.author.username,
                        message: embbedCast.cast.text,
                        imageUrl: "",
                    })
                }
            }

            lastMessages = lastThreeMessages;
        }
        catch (error) {
            console.log('Get Cast Conversation Fail:');
        };

        return lastMessages;
    }
}
