/**
 * This file implements a serializable factory function that is invoked once per sandbox
 * and it is used to create secure proxies where all identities are defined inside
 * the sandbox, this guarantees that any error when interacting with those proxies, has
 * the proper identity to avoid leaking references from the outer realm into the sandbox
 * this is especially important for out of memory errors.
 *
 * IMPORTANT:
 *  - This file can't import anything from the package, only types since it is going to
 *    be serialized, and therefore it will loose the reference.
 */
import {
    SecureEnvironment,
} from './environment';
import {
    SecureProxyTarget,
    SecureValue,
    SecureObject,
    SecureShadowTarget,
    RawConstructor,
    RawFunction,
} from './membrane';
import { TargetMeta } from './membrane';

export type SecureRevocableInitializableProxyFactory = <SecureProxy>(raw: SecureProxyTarget, meta: TargetMeta) => {
    proxy: SecureProxy;
    revoke: () => void;
};

export const serializedSecureProxyFactory = (function secureProxyFactory(env: SecureEnvironment) {
    'use strict';

    const {
        apply,
        construct,
        isExtensible,
        getOwnPropertyDescriptor,
        setPrototypeOf,
        getPrototypeOf,
        preventExtensions,
        deleteProperty,
        ownKeys,
        defineProperty,
    } = Reflect;
    const { seal, freeze, defineProperty: ObjectDefineProperty, create, assign, hasOwnProperty } = Object;
    const ProxyRevocable = Proxy.revocable;
    const emptyArray: [] = [];
    const noop = () => undefined;

    function isUndefined(obj: any): obj is undefined {
        return obj === undefined;
    }

    function isFunction(obj: any): obj is Function {
        return typeof obj === 'function';
    }

    function renameFunction(provider: (...args: any[]) => any, receiver: (...args: any[]) => any) {
        let nameDescriptor: PropertyDescriptor | undefined;
        try {
            // a revoked proxy will break the membrane when reading the function name
            nameDescriptor = getOwnPropertyDescriptor(provider, 'name');
        } catch (_ignored) {
            // intentionally swallowing the error because this method is just extracting the function
            // in a way that it should always succeed except for the cases in which the provider is a proxy
            // that is either revoked or has some logic to prevent reading the name property descriptor.
        }
        if (!isUndefined(nameDescriptor)) {
            defineProperty(receiver, 'name', nameDescriptor);
        }
    }    

    function installDescriptorIntoShadowTarget(shadowTarget: SecureProxyTarget, key: PropertyKey, originalDescriptor: PropertyDescriptor) {
        const shadowTargetDescriptor = getOwnPropertyDescriptor(shadowTarget, key);
        if (!isUndefined(shadowTargetDescriptor)) {
            if (hasOwnProperty.call(shadowTargetDescriptor, 'configurable') &&
                    shadowTargetDescriptor.configurable === true) {
                defineProperty(shadowTarget, key, originalDescriptor);
            } else if (hasOwnProperty.call(shadowTargetDescriptor, 'writable') &&
                    shadowTargetDescriptor.writable === true) {
                // just in case
                shadowTarget[key] = originalDescriptor.value;
            } else {
                // ignoring... since it is non configurable and non-writable
                // usually, arguments, callee, etc.
            }
        } else {
            defineProperty(shadowTarget, key, originalDescriptor);
        }
    }

    function getSecureDescriptor(descriptor: PropertyDescriptor): PropertyDescriptor {
        const secureDescriptor = assign(create(null), descriptor);
        const { value, get, set } = secureDescriptor;
        if ('writable' in secureDescriptor) {
            // we are dealing with a value descriptor
            secureDescriptor.value = isFunction(value) ?
                // we are dealing with a method (optimization)
                env.getSecureFunction(value) : env.getSecureValue(value);
        } else {
            // we are dealing with accessors
            if (isFunction(set)) {
                secureDescriptor.set = env.getSecureFunction(set);
            }
            if (isFunction(get)) {
                secureDescriptor.get = env.getSecureFunction(get);
            }
        }
        return secureDescriptor;
    }

    // equivalent to Object.getOwnPropertyDescriptor, but looks into the whole proto chain
    function getPropertyDescriptor(o: any, p: PropertyKey): PropertyDescriptor | undefined {
        do {
            const d = getOwnPropertyDescriptor(o, p);
            if (!isUndefined(d)) {
                setPrototypeOf(d, null);
                return d;
            }
            o = getPrototypeOf(o);
        } while (o !== null);
        return undefined;
    }

    function copySecureOwnDescriptors(shadowTarget: SecureShadowTarget, descriptors: PropertyDescriptorMap) {
        for (const key in descriptors) {
            // avoid poisoning by checking own properties from descriptors
            if (hasOwnProperty.call(descriptors, key)) {
                const originalDescriptor = getSecureDescriptor(descriptors[key]);
                installDescriptorIntoShadowTarget(shadowTarget, key, originalDescriptor);
            }
        }
    }

    class SecureProxyHandler implements ProxyHandler<SecureProxyTarget> {
        // original target for the proxy
        private readonly target: SecureProxyTarget;
        // metadata about the shape of the target
        private readonly meta: TargetMeta;
    
        constructor(target: SecureProxyTarget, meta: TargetMeta) {
            this.target = target;
            this.meta = meta;
        }
        // initialization used to avoid the initialization cost
        // of an object graph, we want to do it when the
        // first interaction happens.
        initialize(shadowTarget: SecureShadowTarget) {
            const { meta } = this;
            // once the initialization is executed once... the rest is just noop 
            this.initialize = noop;
            // adjusting the proto chain of the shadowTarget (recursively)
            const secProto = env.getSecureValue(meta.proto);
            setPrototypeOf(shadowTarget, secProto);
            // defining own descriptors
            copySecureOwnDescriptors(shadowTarget, meta.descriptors);
            // preserving the semantics of the object
            if (meta.isFrozen) {
                freeze(shadowTarget);
            } else if (meta.isSealed) {
                seal(shadowTarget);
            } else if (!meta.isExtensible) {
                preventExtensions(shadowTarget);
            }
            // future optimization: hoping that proxies with frozen handlers can be faster
            freeze(this);
        }
    
        get(shadowTarget: SecureShadowTarget, key: PropertyKey, receiver: SecureObject): SecureValue {
            this.initialize(shadowTarget);
            const desc = getPropertyDescriptor(shadowTarget, key);
            if (isUndefined(desc)) {
                return desc;
            }
            const { get } = desc;
            if (isFunction(get)) {
                // calling the getter with the secure receiver because the getter expects a secure value
                // it also returns a secure value
                return apply(get, receiver, emptyArray);
            }
            return desc.value;
        }
        set(shadowTarget: SecureShadowTarget, key: PropertyKey, value: SecureValue, receiver: SecureObject): boolean {
            this.initialize(shadowTarget);
            const shadowTargetDescriptor = getPropertyDescriptor(shadowTarget, key);
            if (!isUndefined(shadowTargetDescriptor)) {
                // descriptor exists in the shadowTarget or proto chain
                const { set, get, writable } = shadowTargetDescriptor;
                if (writable === false) {
                    // TypeError: Cannot assign to read only property '${key}' of object
                    return false;
                }
                if (isFunction(set)) {
                    // a setter is available, just call it with the secure value because
                    // the setter expects a secure value
                    apply(set, receiver, [value]);
                    return true;
                }
                if (isFunction(get)) {
                    // a getter without a setter should fail to set in strict mode
                    // TypeError: Cannot set property ${key} of object which has only a getter
                    return false;
                }
            } else if (!isExtensible(shadowTarget)) {
                // non-extensible should throw in strict mode
                // TypeError: Cannot add property ${key}, object is not extensible
                return false;
            }
            // the descriptor is writable on the obj or proto chain, just assign it
            shadowTarget[key] = value;
            return true;
        }
        deleteProperty(shadowTarget: SecureShadowTarget, key: PropertyKey): boolean {
            this.initialize(shadowTarget);
            return deleteProperty(shadowTarget, key);
        }
        apply(shadowTarget: SecureShadowTarget, thisArg: SecureValue, argArray: SecureValue[]): SecureValue {
            const { target } = this;
            try {
                this.initialize(shadowTarget);
                const rawThisArg = env.getRawValue(thisArg);
                const rawArgArray = env.getRawArray(argArray);
                const raw = apply(target as RawFunction, rawThisArg, rawArgArray);
                return env.getSecureValue(raw);
            } catch (e) {
                // by throwing a new secure error, we prevent stack overflow errors
                // from outer realm to leak into the sandbox
                throw e;
            }
        }
        construct(shadowTarget: SecureShadowTarget, argArray: SecureValue[], newTarget: SecureObject): SecureObject {
            const { target } = this;
            try {
                this.initialize(shadowTarget);
                if (isUndefined(newTarget)) {
                    throw TypeError();
                }
                const rawArgArray = env.getRawArray(argArray);
                const rawNewTarget = env.getRawValue(newTarget);
                const raw = construct(target as RawConstructor, rawArgArray, rawNewTarget);
                return env.getSecureValue(raw);
            } catch (e) {
                // by throwing a new secure error, we prevent stack overflow errors
                // from outer realm to leak into the sandbox
                throw e;
            }
        }
        has(shadowTarget: SecureShadowTarget, key: PropertyKey): boolean {
            this.initialize(shadowTarget);
            return key in shadowTarget;
        }
        ownKeys(shadowTarget: SecureShadowTarget): PropertyKey[] {
            this.initialize(shadowTarget);
            return ownKeys(shadowTarget);
        }
        isExtensible(shadowTarget: SecureShadowTarget): boolean {
            this.initialize(shadowTarget);
            // No DOM API is non-extensible, but in the sandbox, the author
            // might want to make them non-extensible
            return isExtensible(shadowTarget);
        }
        getOwnPropertyDescriptor(shadowTarget: SecureShadowTarget, key: PropertyKey): PropertyDescriptor | undefined {
            this.initialize(shadowTarget);
            // TODO: this is leaking outer realm's object
            return getOwnPropertyDescriptor(shadowTarget, key);
        }
        getPrototypeOf(shadowTarget: SecureShadowTarget): SecureValue {
            this.initialize(shadowTarget);
            // nothing to be done here since the shadowTarget must have the right proto chain
            return getPrototypeOf(shadowTarget);
        }
        setPrototypeOf(shadowTarget: SecureShadowTarget, prototype: SecureValue): boolean {
            this.initialize(shadowTarget);
            // this operation can only affect the env object graph
            return setPrototypeOf(shadowTarget, prototype);
        }
        preventExtensions(shadowTarget: SecureShadowTarget): boolean {
            this.initialize(shadowTarget);
            // this operation can only affect the env object graph
            return preventExtensions(shadowTarget);
        }
        defineProperty(shadowTarget: SecureShadowTarget, key: PropertyKey, descriptor: PropertyDescriptor): boolean {
            this.initialize(shadowTarget);
            // this operation can only affect the env object graph
            // intentionally using Object.defineProperty instead of Reflect.defineProperty
            // to throw for existing non-configurable descriptors.
            ObjectDefineProperty(shadowTarget, key, descriptor);
            return true;
        }
    }
    
    setPrototypeOf(SecureProxyHandler.prototype, null);

    function createSecureShadowTarget(target: SecureProxyTarget): SecureShadowTarget {
        let shadowTarget;
        if (isFunction(target)) {
            // this is never invoked just needed to anchor the realm for errors
            shadowTarget = function () {};
            renameFunction(target as (...args: any[]) => any, shadowTarget as (...args: any[]) => any);
        } else {
            // o is object
            shadowTarget = {};
        }
        return shadowTarget;
    }

    return function createSecureProxy(raw: SecureProxyTarget, meta: TargetMeta) {
        const shadowTarget = createSecureShadowTarget(raw);
        const proxyHandler = new SecureProxyHandler(raw, meta);
        return ProxyRevocable(shadowTarget, proxyHandler);
    } as SecureRevocableInitializableProxyFactory;

}).toString();