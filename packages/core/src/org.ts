import {
    bytesToBase64,
    base64ToBytes,
    bytesToString,
    stringToBytes,
    Serializable,
    unmarshal,
    marshal
} from "./encoding";
import { getProvider, RSAPrivateKey, RSAPublicKey, RSAKeyParams, HMACKeyParams, RSASigningParams } from "./crypto";
import { SharedContainer } from "./container";
import { Err, ErrorCode } from "./error";
import { Storable } from "./storage";
import { Vault, VaultID } from "./vault";
import { Group, GroupID } from "./group";
import { Account, AccountID } from "./account";

export class OrgMember extends Serializable {
    id: AccountID = "";
    name = "";
    email = "";
    publicKey!: RSAPublicKey;
    signedPublicKey!: Uint8Array;

    constructor(vals?: Partial<OrgMember>) {
        super();
        if (vals) {
            Object.assign(this, vals);
        }
    }

    toRaw() {
        return {
            ...super.toRaw(),
            publicKey: bytesToBase64(this.publicKey),
            signedPublicKey: bytesToBase64(this.signedPublicKey)
        };
    }

    validate() {
        return (
            typeof this.id === "string" &&
            typeof this.name === "string" &&
            typeof this.email === "string" &&
            this.publicKey instanceof Uint8Array &&
            this.signedPublicKey instanceof Uint8Array
        );
    }

    fromRaw({ id, name, publicKey, signedPublicKey, vaults, ...rest }: any) {
        Object.assign(this, {
            id,
            name,
            publicKey: base64ToBytes(publicKey),
            signedPublicKey: base64ToBytes(signedPublicKey),
            vaults
        });

        return super.fromRaw(rest);
    }
}

export type OrgID = string;
export type OrgRole = "admin" | "member";

export class Org extends SharedContainer implements Storable {
    id: string = "";
    name: string = "";
    publicKey!: RSAPublicKey;
    privateKey!: RSAPrivateKey;
    invitesKey!: Uint8Array;
    signingParams = new RSASigningParams();
    members: OrgMember[] = [];
    groups: Group[] = [];
    vaults: {
        id: VaultID;
        name: string;
    }[] = [];
    adminGroup: Group = new Group();
    everyoneGroup: Group = new Group();

    toRaw() {
        return {
            ...super.toRaw(),
            publicKey: bytesToBase64(this.publicKey)
        };
    }

    validate() {
        return (
            typeof this.name === "string" &&
            typeof this.id === "string" &&
            this.publicKey instanceof Uint8Array &&
            this.vaults.every(({ id, name }: any) => typeof id === "string" && typeof name === "string")
        );
    }

    fromRaw({ id, name, publicKey, members, groups, vaults, adminGroup, everyoneGroup, signingParams, ...rest }: any) {
        this.signingParams.fromRaw(signingParams);
        this.adminGroup.fromRaw(adminGroup);
        this.everyoneGroup.fromRaw(everyoneGroup);

        Object.assign(this, {
            id,
            name,
            publicKey: base64ToBytes(publicKey),
            members: members.map((m: any) => new OrgMember().fromRaw(m)),
            groups: groups.map((g: any) => new Group().fromRaw(g)),
            vaults
        });

        return super.fromRaw(rest);
    }

    isAdmin(m: { id: string }) {
        return !!this.adminGroup.isMember(m);
    }

    getMember(id: AccountID) {
        return this.members.find(m => m.id === id);
    }

    getGroup(id: GroupID) {
        return this.groups.find(g => g.id === id);
    }

    getMembersForGroup(group: Group): OrgMember[] {
        return group.accessors
            .map(({ id }) => this.getMember(id))
            // Filter out undefined members
            .filter(m => !!m) as OrgMember[];
    }

    getGroupsForMember({ id }: OrgMember) {
        return this.groups.filter(g => g.accessors.some(a => a.id === id));
    }

    async initialize(account: Account) {
        // Add account to admin group
        await this.adminGroup.updateAccessors([account]);

        // Generate admin group keys
        await this.adminGroup.generateKeys();

        // Grant admin group access to
        await this.updateAccessors([this.adminGroup]);

        await this.generateKeys();

        await this.addMember(account);

        await this.everyoneGroup.generateKeys();

        await this.sign(this.adminGroup);
        await this.sign(this.everyoneGroup);
    }

    async generateKeys() {
        this.invitesKey = await getProvider().generateKey(new HMACKeyParams());
        const { privateKey, publicKey } = await getProvider().generateKey(new RSAKeyParams());
        this.privateKey = privateKey;
        this.publicKey = publicKey;
        await this.setData(
            stringToBytes(
                marshal({ privateKey: bytesToBase64(privateKey), invitesKey: bytesToBase64(this.invitesKey) })
            )
        );
    }

    async access(account: Account) {
        await this.adminGroup.access(account);
        await super.access(this.adminGroup);
        if (this.encryptedData) {
            const { privateKey, invitesKey } = unmarshal(bytesToString(await this.getData()));
            this.privateKey = base64ToBytes(privateKey);
            this.invitesKey = base64ToBytes(invitesKey);
        }
    }

    async addMember(account: { id: string; name: string; email: string; publicKey: Uint8Array }) {
        if (!this.privateKey) {
            throw new Err(ErrorCode.INSUFFICIENT_PERMISSIONS);
        }

        const member = new OrgMember(await this.sign(account));
        this.members.push(member);
        await this.everyoneGroup.updateAccessors(this.members);
    }

    async sign(obj: { publicKey: Uint8Array; signedPublicKey?: Uint8Array }) {
        obj.signedPublicKey = await getProvider().sign(this.privateKey, obj.publicKey, this.signingParams);
        return obj;
    }

    async verify(subj: OrgMember | Group): Promise<boolean> {
        let verified = false;
        if (!subj.signedPublicKey) {
            return false;
        }
        try {
            verified = await getProvider().verify(
                this.publicKey,
                subj.signedPublicKey,
                subj.publicKey,
                this.signingParams
            );
        } catch (e) {}
        return verified;
    }

    async createVault(name: string) {
        const vault = new Vault();
        vault.name = name;
        vault.org = this.id;
        await vault.updateAccessors([this.adminGroup]);
    }
}
