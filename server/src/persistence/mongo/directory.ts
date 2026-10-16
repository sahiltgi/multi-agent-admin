// EmployeeDirectory on MongoDB (spec mongo-persistence, rules 1 and 2).
import { Employee } from '../../domain/schemas.js';
import type { EmployeeDirectory } from '../../http/approvals/ports.js';
import { MODELS } from '../../models/index.js';
import { literal, NO_STORAGE_KEYS, parseStored } from './read.js';

export class MongoEmployeeDirectory implements EmployeeDirectory {
  /** Exact id match only: no trimming and no case folding (rule 2). */
  async getById(id: string): Promise<Employee | null> {
    const doc = await MODELS.Employee.findOne({ id: literal(id) }, NO_STORAGE_KEYS)
      .lean()
      .exec();
    return doc === null ? null : parseStored(Employee, 'employees', doc);
  }
}
