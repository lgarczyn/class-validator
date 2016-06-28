import {Validator} from "./Validator";
import {ValidationError} from "./ValidationError";
import {ValidationMetadata} from "../metadata/ValidationMetadata";
import {MetadataStorage} from "../metadata/MetadataStorage";
import {getFromContainer} from "../index";
import {ValidatorOptions} from "./ValidatorOptions";
import {ValidationTypes} from "./ValidationTypes";
import {ValidatorConstraintInterface} from "./ValidatorConstraintInterface";
import {ConstraintMetadata} from "../metadata/ConstraintMetadata";

/**
 * Executes validation over given object.
 */
export class ValidationExecutor {

    // -------------------------------------------------------------------------
    // Properties
    // -------------------------------------------------------------------------

    private errors: ValidationError[] = [];
    private awaitingPromises: Promise<any>[] = [];

    // -------------------------------------------------------------------------
    // Private Properties
    // -------------------------------------------------------------------------

    private metadataStorage = getFromContainer(MetadataStorage);

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(private validator: Validator,
                private validatorOptions?: ValidatorOptions) {
    }
    
    // -------------------------------------------------------------------------
    // Public Methods
    // -------------------------------------------------------------------------
    
    execute(object: Object, targetSchema?: string) {
        const groups = this.validatorOptions ? this.validatorOptions.groups : undefined;
        const targetMetadatas = this.metadataStorage.getTargetValidationMetadatas(object.constructor, targetSchema, groups);
        const groupedMetadatas = this.metadataStorage.groupByPropertyName(targetMetadatas);

        Object.keys(groupedMetadatas).forEach(propertyName => {
            const value = (object as any)[propertyName];
            const metadatas = groupedMetadatas[propertyName];
            const customValidationMetadatas = metadatas.filter(metadata => metadata.type === ValidationTypes.CUSTOM_VALIDATION);
            const nestedValidationMetadatas = metadatas.filter(metadata => metadata.type === ValidationTypes.NESTED_VALIDATION);
            const notEmptyMetadatas = metadatas.filter(metadata => metadata.type === ValidationTypes.NOT_EMPTY);
            
            // handle NOT_EMPTY validation type the special way - it should work no matter skipMissingProperties is set or not
            this.defaultValidations(object, value, notEmptyMetadatas);
            
            if (!value && this.validatorOptions && this.validatorOptions.skipMissingProperties === true)
                return;
            
            this.defaultValidations(object, value, metadatas);
            this.customValidations(object, value, customValidationMetadatas);
            this.nestedValidations(value, nestedValidationMetadatas);
        });

        return Promise.all(this.awaitingPromises).then(() => this.errors);
    }
    
    // -------------------------------------------------------------------------
    // Private Methods
    // -------------------------------------------------------------------------

    private defaultValidations(object: Object, value: any, metadatas: ValidationMetadata[]) {
        return metadatas
            .filter(metadata => {
                if (metadata.each) {
                    if (value instanceof Array) {
                        return !value.every((subValue: any) => this.validator.validateValueByMetadata(subValue, metadata));
                        // } else {
                        //     throw new Error(`Cannot validate ${(metadata.target as any).name}#${metadata.propertyName} because supplied value is not an array, however array is expected for validation.`);
                    }

                } else {
                    return !this.validator.validateValueByMetadata(value, metadata);
                }
            })
            .forEach(metadata => {
                this.errors.push(this.createValidationError(object, value, metadata));
            });
    }

    private customValidations(object: Object, value: any, metadatas: ValidationMetadata[]) {
        metadatas.forEach(metadata => {
            getFromContainer(MetadataStorage)
                .getTargetValidatorConstraints(metadata.constraintCls)
                .forEach(customConstraintMetadata => {
                    const validatedValue = customConstraintMetadata.instance.validate(value, object, metadata.constraints);
                    if (validatedValue instanceof Promise) {
                        const promise = validatedValue.then(isValid => {
                            if (!isValid) {
                                this.errors.push(this.createValidationError(object, value, metadata, customConstraintMetadata));
                            }
                        });
                        this.awaitingPromises.push(promise);
                    } else {
                        if (!validatedValue)
                            this.errors.push(this.createValidationError(object, value, metadata, customConstraintMetadata));
                    }
                });
        });
    }
    
    private nestedValidations(value: any, metadatas: ValidationMetadata[]) {
        metadatas.forEach(metadata => {
            if (metadata.type !== ValidationTypes.NESTED_VALIDATION) return;
            const targetSchema = typeof metadata.target === "string" ? metadata.target as string : undefined;

            if (value instanceof Array) {
                value.forEach((subValue: any) => this.awaitingPromises.push(this.execute(subValue, targetSchema)));

            } else if (value instanceof Object) {
                this.awaitingPromises.push(this.execute(value, targetSchema));

            } else {
                throw new Error("Only objects and arrays are supported to nested validation");
            }
        });
    }

    private createValidationError(target: Object,
                                  value: any,
                                  metadata: ValidationMetadata,
                                  customValidatorMetadata?: ConstraintMetadata): ValidationError {
        let message: string;
        if (metadata.message instanceof Function) {
            message = (metadata.message as ((value?: any, constraints?: any[]) => string))(value, metadata.constraints);

        } else if (typeof metadata.message === "string") {
            message = metadata.message as string;

        } else if (this.validatorOptions && !this.validatorOptions.dismissDefaultMessages) {
            // message = this.defaultMessages.getFor(metadata.type);
        }

        if (message && metadata.constraints instanceof Array)
            metadata.constraints.forEach((constraint, index) => message.replace(new RegExp(`\$constraint${index}`, "g"), constraint));
        if (message && value !== undefined && value !== null)
            message = message.replace(/\$value/g, value);

        return {
            target: target.constructor ? (target.constructor as any).name : undefined,
            property: metadata.propertyName,
            type: customValidatorMetadata && customValidatorMetadata.name ? customValidatorMetadata.name : metadata.type,
            message: message,
            value: value
        };
    }
    
}