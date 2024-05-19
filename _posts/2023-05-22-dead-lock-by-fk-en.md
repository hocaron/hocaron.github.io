---
layout: post
title:  "[Troubleshooting - DB] Foreign Key, Deadlock, and Query Delay Execution"
tags: Troubleshooting
excerpt_separator: <!--more-->
lang: en
permalink: /dead-lock-by-fk/
---

## Foreign Key and Deadlock
**Deadlock** occurs when two or more processes are each waiting for the other to release a resource, resulting in a situation where none of the processes can proceed.  
![Deadlock diagram](https://velog.velcdn.com/images/haron/post/33d1e1aa-b838-40e9-bbbd-af4480a0d5fe/image.png)  
In this scenario, P1 waits for the resource held by P2, P2 waits for the resource held by P3, and so on, until the last process Pn waits for the resource held by P1, creating a circular wait and causing a deadlock.

**Foreign Key** is a key used to link two tables together. The table containing the foreign key is called the child table, and the table referenced by the foreign key is called the parent table.

> In "Real MySQL" chapter 3, it states:
"Foreign keys can cause deadlocks as they require checking for data in both the parent and child tables, propagating locks across multiple tables. Hence, they are rarely used in practice."

![Locks propagation](https://velog.velcdn.com/images/haron/post/9cb67c04-19fc-4701-98c1-b6a45971eaa9/image.png)  
Oh... Locks propagate across multiple tables?!!

## Reproducing Deadlock Situations
### Preparation Steps

```sql
CREATE TABLE parent
(
    id             bigint        not null primary key,
    name           varchar(255)  null,
    updated_at     datetime(6)   null
);

CREATE TABLE child
(
    id           bigint          not null primary key,
    name         varchar(255)    null,
    parent_id    bigint          null,
    CONSTRAINT parent_id_unique UNIQUE (parent_id),
    CONSTRAINT child_fk FOREIGN KEY (parent_id) REFERENCES parent (id)
);

CREATE TABLE child_index
(
    id           bigint          not null primary key,
    name         varchar(255)    null,
    parent_id    bigint          null,
    CONSTRAINT child_index_fk FOREIGN KEY (parent_id) REFERENCES parent (id)
);
CREATE INDEX parent_id ON child_index (parent_id);

INSERT INTO parent VALUES (1, 'parent_1', NOW());
```
1. Create the child table with a foreign key/unique key referencing the parent table's id.
2. Create the child_index table with a foreign key/index referencing the parent table's id.
3. Insert test data into the parent table.

### Now, Let's Cause a Deadlock
### If a child row insert and a parent row update are performed in two sessions, a deadlock occurs 💣
![Deadlock situation](https://velog.velcdn.com/images/haron/post/64f10100-a470-43a9-af95-c4a372b5bd22/image.png)

|TX1|TX2|lock|
|------|---|---|
|BEGIN ;  <br> INSERT INTO child VALUES (1, 'child1', 1);||(1) child X, REC_NOT_GAP Lock, parent S Lock|
||BEGIN ;  <br> INSERT INTO child VALUES (1, 'child1', 1);|(2) child X Lock waiting, parent S Lock|
|UPDATE parent SET name = 'newParent' WHERE id = 1;||(3)|
||Deadlock found when trying to get lock; try restarting transaction|(3) parent X lock required, but parent is in S lock in (2) <br> To resolve (3), (2) needs to be resolved <br> -> To resolve (2), TX1 commit is required <br> -> To commit TX1, (3) needs to be resolved <br> -> Deadlock occurs|

![Deadlock explanation](https://velog.velcdn.com/images/haron/post/609d3b4c-6e3d-4743-af14-5449b7b730fe/image.jpeg)

> When performing a write query on the child table, the foreign key constraint causes the parent's lock state to be checked. If there's no issue, the query is executed, and to maintain consistency, a shared lock is placed on the corresponding row in the parent table.

> **Shared Lock (S Lock)**  
A shared lock, also known as a read lock, allows read operations (SELECT) on the locked data but prohibits write operations. Other transactions can acquire a shared lock on the same data, but cannot acquire an exclusive lock. This ensures that the data cannot be modified while it's being read, maintaining transaction integrity.

> **Exclusive Lock (X Lock)**  
An exclusive lock, also known as a write lock, allows both read and write operations for the transaction that holds the lock. Other transactions cannot perform any operations (read or write) on the locked data. This guarantees exclusive access to the locked data for the transaction holding the lock.

### If a parent row update and a child row insert are performed in two sessions, a duplicate key error occurs instead of a deadlock
![Duplicate key error](https://velog.velcdn.com/images/haron/post/f36e285b-25f9-42f7-a233-7864a0ad9244/image.png)  
If the parent row is updated first, a deadlock does not occur. The duplicate key error is an expected behavior due to service-specific requirements.

## Analyzing the Logic Causing Deadlock in Production
- The service uses JPA, so let's check with the `show-sql` option.
```sql
SELECT * from parent WHERE id = 1;
INSERT INTO child VALUES (1, 'child_1', 1);
DELETE FROM child_index WHERE parent_id = 1;
INSERT INTO child_index VALUES (1, 'child_index_1', 1);
UPDATE parent SET  updated_at = NOW() WHERE id = 1;
```
(Tables and columns are simplified versions)

### If a child row insert and a parent row update are performed in two sessions, a deadlock occurs 💣
![Deadlock diagram](https://velog.velcdn.com/images/haron/post/b5700769-98a0-45f6-9858-2594d362f922/image.png)

- The reason for execution in two sessions is due to multiple simultaneous requests from the front end 🖱🤏🖱🤏.
- It's curious that this issue only occurs with this specific button, while other buttons do not cause deadlocks 🤔.

## Understanding the Cause and Exploring Solutions to Deadlock

### ❎ First Attempt: Adjust Logic to Perform Parent Row Update Before Child Row Insert to Cause a Duplicate Key Error
```java
  @Transactional
  public void createChildAndChildIndex (long parentId) {

    var parent = parentRepository.findById(parentId);
    // Update parent row
    parent.setUpdatedAt(LocalDateTime.now());
    
    // Insert child row
    childRepository.save(new Child('child_1', parent));
    
    childIndexRepository.deleteByParent(parent);
    childIndexRepository.save(new Child_Index('child_index_1', parent));

  }
```
However, queries are still executed in the order: child row insert → parent row update, causing deadlocks. 😇

### Hibernate Query Execution Order
Although it is known that JPA's write-behind strategy defers query execution until the transaction commits, there is an order of execution.

```
OrphanRemovalAction
AbstractEntityInsertAction
EntityUpdateAction
QueuedOperationCollectionAction
CollectionRemoveAction
CollectionUpdateAction
CollectionRecreateAction
EntityDeleteAction

1. Inserts, in the order they were performed
2. Updates
3. Deletion of collection elements
4. Insertion of collection elements
5. Deletes, in the order they were performed
```
FYI: [Hibernate Query Execution Order](https://docs.jboss.org/hibernate/orm/6.1/javadocs/org/hibernate/event/internal/AbstractFlushingEventListener.html#performExecutions(org.hibernate.event.spi.EventSource))

> **What is a Foreign Key Constraint?**
When inserting data into a table with a foreign key, the referenced table must contain the actual data being referenced. This ensures data integrity by preventing references to non-existent data. This is likely why inserts are executed first!

The reason the logic still results in a child row insert before a parent row update is due to the write-behind strategy, where inserts are prioritized over updates.

### ❎ Second Attempt: Use `flush()` After Parent Row Update to Ensure Query Execution Order
```java
  @Transactional
  public void createParent (long parentId) {

    var parent = parentRepository.findById(parentId);
    // Update parent row
    parent.setUpdatedAt(LocalDateTime.now());
    // Flush after parent row update
    parentRepository.flush();
    
    // Insert child row
    childRepository.save(new Child('child_1', parent));
    
    childIndexRepository.deleteByParent(parent);
    childIndexRepository.save(new Child_Index('child_index_1', parent));

  }
```

Queries are executed as intended!
```sql
SELECT * from parent WHERE id = 1;
UPDATE parent SET  updated_at = NOW() WHERE id = 1;
INSERT INTO child VALUES (1, 'child_1', 1);
DELETE FROM child_index WHERE parent_id = 1;
INSERT INTO child_index VALUES (1, 'child_index_1', 1);
```
- However, there are concerns about potential side effects of `flush()` and confusion for future developers seeing an unexpected `flush()` call.

### ✅ Third Attempt: Remove Foreign Key from the Child Table
🤔 How long does it take to remove a foreign key from a table with 2,288,112 rows?!

- The deadlock occurs because a change in a child row also causes a shared lock on the parent row. Removing the root cause might solve the problem.
- Concerned about potential service downtime during foreign key removal, we tested it. On a table with 54,973 rows, it took only 14 ms.

![Foreign key removal time](https://velog.velcdn.com/images/haron/post/b66d04a1-8e93-4f24-a8bb-f135946f7669/image.png)
- After discussing within the team, we removed the foreign key without service interruption. Monitoring showed that after removing the foreign key, `SQLTransactionRollbackException` (deadlock) was replaced by `DataIntegrityViolationException` (duplicate key).

![Post foreign key removal](https://velog.velcdn.com/images/haron/post/fa8c8a3e-ad61-4977-b1ff-585b0d262293/image.png)

### Not Defeated Yet...
[The Index Was Waiting for Me...](https://velog.io/@haron/%ED%8A%B8%EB%9F%AC%EB%B8%94%EC%8A%88%ED%8C%85-DB-%EC%9D%B8%EB%8D%B1%EC%8A%A4Index%EC%99%80-%EB%8D%B0%EB%93%9C%EB%9D%BDDeadLock-in8ryzsm)

## Summary
1. When a foreign key is present, a change in a child row causes a shared lock on the parent row.
2. There is an execution order for JPA's write-behind strategy.
3. The time taken to remove an FK key is shorter than expected.

### For the Record
<details>
<summary>SHOW ENGINE innodb STATUS;</summary>
- SHOW ENGINE innodb STATUS;
  LOCK WAIT 4 lock struct(s), heap size 1128, 2 row lock(s), undo log entries 1
  *** (1) HOLDS THE LOCK(S):

RECORD LOCKS space id 148 page no 4 n bits 72 index PRIMARY of table `jpa`.`parent` trx id 12534 lock mode S locks rec but not gap

Record lock, heap no 2 PHYSICAL RECORD: n_fields 4; compact format; info bits 0

*** (1) WAITING FOR THIS LOCK TO BE GRANTED:
RECORD LOCKS space id 149 page no 5 n bits 72 index parent_id_unique of table `jpa`.`child` trx id 12534 lock mode S waiting
Record lock, heap no 2 PHYSICAL RECORD: n_fields 2; compact format; info bits 0

*** (2) TRANSACTION:

TRANSACTION 12533, ACTIVE 13 sec starting index read

mysql tables in use 1, locked 1

LOCK WAIT 6 lock struct(s), heap size 1128, 3 row lock(s), undo log entries 1

MySQL thread id 128, OS thread handle 6143324160, query id 12894 localhost 127.0.0.1 root updating

/* ApplicationName=DataGrip 2022.3.2 */ UPDATE parent SET name = 'newParent' WHERE id = 1

*** (2) HOLDS THE LOCK(S):
RECORD LOCKS space id 149 page no 5 n bits 72 index parent_id_unique of table `jpa`.`child` trx id 12533 lock_mode X locks rec but not gap
Record lock, heap no 2 PHYSICAL RECORD: n_fields 2; compact format; info bits 0

*** (2) WAITING FOR THIS LOCK TO BE GRANTED:
RECORD LOCKS space id 148 page no 4 n bits 72 index PRIMARY of table `jpa`.`parent` trx id 12533 lock_mode X locks rec but not gap waiting

Record lock, heap no 2 PHYSICAL RECORD: n_fields 4; compact format; info bits 0
</details>
